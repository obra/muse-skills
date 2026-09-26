// The CVM builder's rejection contract, in its own module because
// `build-cvm-client.ts` runs `main()` on import: anything that only needs to
// name the contract (its own tests, any future caller) must be able to do so
// without building a Space as a side effect.

/// Exit code for a document this builder will never convert, however many
/// times it is handed the same bytes: the page uses a construct private
/// rendering has no expression for. It is the author's to fix, so the caller
/// records it against the artifact digest and stops re-running the builder
/// rather than retrying forever. Every other failure keeps exit 1 and stays
/// retryable. 65 is sysexits.h EX_DATAERR ("the input data was incorrect").
///
/// Mirrored in Rust as `CVM_BUILDER_UNSUPPORTED_DOCUMENT_EXIT`
/// (`hatch-spaces/src/build_pipeline/build.rs`); keep the two in lockstep.
export const EXIT_UNSUPPORTED_DOCUMENT = 65;

/// Printed to stderr immediately before exiting `EXIT_UNSUPPORTED_DOCUMENT`.
///
/// The exit code alone cannot carry this decision: 65 is generic EX_DATAERR,
/// and a bun/node loader crash or any wrapper between us and the caller can
/// produce it for reasons that have nothing to do with the document. Treating
/// such an exit as terminal would record a perfectly convertible Space as
/// unconvertible against its digest and skip it on every later sweep until its
/// author happened to rebuild. The caller therefore requires BOTH this
/// sentinel and the exit code; anything less stays retryable.
export const UNSUPPORTED_DOCUMENT_SENTINEL = "hatch-cvm-rejected:unsupported-document";

/// A document-contract rejection. Thrown only where the input is the problem;
/// builder faults, missing inputs and bad invocation stay ordinary Errors.
export class UnsupportedDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDocumentError";
  }
}
