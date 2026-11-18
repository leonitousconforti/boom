//! Fixed-column and delimited plain-text catalogs, optionally gzipped.
//!
//! 2MASS and VSX publish this way: one record per line, no header, parsed by a
//! per-catalog [`FromAsciiRow`] impl rather than by serde.

use super::ingest::{HasCoordinates, IngestError, IngestReport, Inserter};
use serde::Serialize;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use tracing::instrument;

/// Parse one line of a catalog's published text format.
pub trait FromAsciiRow: Sized {
    fn from_line(line: &str) -> Result<Self, String>;
}

/// Open a text file, transparently decompressing `.gz`.
fn open_lines(path: &Path) -> Result<Box<dyn BufRead>, std::io::Error> {
    let file = File::open(path)?;
    if path.extension().is_some_and(|e| e == "gz") {
        Ok(Box::new(BufReader::new(flate2::read::GzDecoder::new(file))))
    } else {
        Ok(Box::new(BufReader::new(file)))
    }
}

/// How many unparseable lines to tolerate before giving up on a file.
///
/// A handful of bad rows in a hundred-million-row catalog is upstream noise; a
/// file that is mostly rejects means the format changed, and ingesting the
/// remainder would quietly install a half-empty catalog.
const MAX_PARSE_ERRORS: u64 = 100;

#[instrument(skip(inserter), fields(path = %path.display()), err)]
pub async fn ingest_ascii<T>(inserter: &Inserter, path: &Path) -> Result<IngestReport, IngestError>
where
    T: Serialize + HasCoordinates + FromAsciiRow + Send + 'static,
{
    // Opened before the workers start: failing after that would drop their
    // join handles without awaiting them.
    let reader = open_lines(path).map_err(|e| IngestError::Read(e.to_string()))?;

    let (sender, workers) = inserter.start::<T>();
    let mut report = IngestReport::default();
    let mut first_error: Option<String> = None;
    // Held and returned after `finish`, for the reason given in csv.rs.
    let mut failure: Option<IngestError> = None;
    for (line_number, line) in reader.lines().enumerate() {
        let parsed = match line {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => T::from_line(&line),
            // A line that is not UTF-8 has been consumed, so it counts as one
            // that does not parse.
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => Err(e.to_string()),
            // Any other read error ends the file: a truncated gzip returns it
            // on every read that follows.
            Err(e) => {
                failure = Some(IngestError::Read(format!(
                    "{}: line {}: {}",
                    path.display(),
                    line_number + 1,
                    e
                )));
                break;
            }
        };
        match parsed {
            Ok(record) => {
                report.read += 1;
                // A send failure means every worker is gone, which `finish`
                // below will report properly; stop feeding a dead channel.
                if sender.send(record).await.is_err() {
                    break;
                }
            }
            Err(e) => {
                report.skipped += 1;
                first_error.get_or_insert_with(|| format!("line {}: {}", line_number + 1, e));
                if report.skipped > MAX_PARSE_ERRORS {
                    drop(sender);
                    inserter.finish(workers).await?;
                    return Err(IngestError::Read(format!(
                        "{}: gave up after {} unparseable lines, first was {}",
                        path.display(),
                        report.skipped,
                        first_error.unwrap_or_default()
                    )));
                }
            }
        }
    }

    drop(sender);
    let tally = inserter.finish(workers).await;
    if let Some(e) = failure {
        return Err(e);
    }
    let tally = tally?;
    report.inserted = tally.inserted;
    report.skipped += tally.skipped;
    if let Some(e) = first_error {
        tracing::warn!(
            skipped = report.skipped,
            "skipped unparseable lines in {}, first was {}",
            path.display(),
            e
        );
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[derive(Serialize)]
    struct Row {
        _id: u64,
    }

    impl HasCoordinates for Row {
        fn has_coordinates() -> bool {
            false
        }
    }

    impl FromAsciiRow for Row {
        fn from_line(line: &str) -> Result<Self, String> {
            line.trim()
                .parse()
                .map(|_id| Row { _id })
                .map_err(|e| format!("{e}"))
        }
    }

    /// Ingest `bytes`, saved as `file_name`, into a fresh collection. Returns the
    /// outcome and how many documents were written.
    async fn ingest(file_name: &str, bytes: &[u8]) -> (Result<IngestReport, IngestError>, u64) {
        let db = crate::conf::get_test_db().await;
        let name = format!("test_ascii_{}", uuid::Uuid::new_v4().simple());
        let collection = db.collection::<mongodb::bson::Document>(&name);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(file_name);
        std::fs::write(&path, bytes).unwrap();

        let inserter = Inserter::new(db.clone(), name.as_str(), 2, 1, 4);
        let outcome = ingest_ascii::<Row>(&inserter, &path).await;
        let written = collection
            .count_documents(mongodb::bson::doc! {})
            .await
            .unwrap();
        collection.drop().await.unwrap();
        (outcome, written)
    }

    fn gzipped_rows() -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        for id in 1..=3 {
            writeln!(gz, "{id}").unwrap();
        }
        gz.finish().unwrap()
    }

    #[tokio::test]
    async fn a_truncated_gzip_fails_the_file_after_writing_what_it_read() {
        let mut bytes = gzipped_rows();
        // The trailer, as when a download stops just short of the end.
        bytes.truncate(bytes.len() - 8);
        let (outcome, written) = ingest("chunk.gz", &bytes).await;

        assert!(
            matches!(outcome, Err(IngestError::Read(_))),
            "{:?}",
            outcome.map(|r| r.read)
        );
        assert_eq!(written, 3);
    }

    #[tokio::test]
    async fn a_corrupt_gzip_fails_the_file_after_writing_what_it_read() {
        let mut bytes = gzipped_rows();
        // The trailer's checksum, which is checked once every row has been read.
        let crc = bytes.len() - 8;
        bytes[crc] ^= 0xff;
        let (outcome, written) = ingest("chunk.gz", &bytes).await;

        assert!(
            matches!(outcome, Err(IngestError::Read(_))),
            "{:?}",
            outcome.map(|r| r.read)
        );
        assert_eq!(written, 3);
    }

    #[tokio::test]
    async fn a_line_that_is_not_utf8_is_skipped_like_one_that_does_not_parse() {
        let (outcome, written) = ingest("chunk.txt", b"1\n\xff\xfe\n2\n").await;
        let report = outcome.unwrap();

        assert_eq!((report.read, report.skipped, written), (2, 1, 2));
    }
}
