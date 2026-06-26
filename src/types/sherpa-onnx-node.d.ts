// Ambient declaration for the optional `sherpa-onnx-node` native dependency.
// It is loaded via dynamic import() and may not be installed, so it has no
// bundled types. Declaring it `any` lets the STT code type-check without
// forcing the package to be present at build time.
declare module 'sherpa-onnx-node';
