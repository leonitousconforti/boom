{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };
  outputs =
    { nixpkgs, ... }:
    let
      forAllSystems =
        function:
        nixpkgs.lib.genAttrs [
          "x86_64-linux"
          "aarch64-linux"
          "aarch64-darwin"
        ] (system: function nixpkgs.legacyPackages.${system});
    in
    {
      formatter = forAllSystems (pkgs: pkgs.nixfmt);
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nixd
            nixfmt

            cargo
            rustc
            clippy
            rustfmt
            rust-analyzer
            cargo-watch
            pkg-config
            perl
            gnumake
            rustPlatform.bindgenHook

            # kafka-configs and kafka-acls, which the Kafka credential tests run.
            apacheKafka

            python3
            uv
            bun
            yq-go
            pre-commit
            git-lfs
          ];

          buildInputs = with pkgs; [
            cyrus_sasl
            cfitsio
            openssl
          ];

          # Debug builds compile jemalloc at -O0, where _FORTIFY_SOURCE warns and
          # its configure probes, which build with -Werror, then fail.
          hardeningDisable = [ "fortify" ];

          env = {
            RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          }
          # ort loads ONNX Runtime at run time on Linux (`load-dynamic`).
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            ORT_DYLIB_PATH = "${pkgs.onnxruntime}/lib/libonnxruntime.so";
          };
        };
      });
    };
}
