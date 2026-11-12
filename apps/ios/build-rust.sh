#!/usr/bin/env bash
# Build the Rust core for iOS and generate its Swift bindings.
#
# Produces (both gitignored, regenerate any time the Rust API changes):
#   apps/ios/OuraCore.xcframework          static lib for device + simulator
#   apps/ios/OuraApp/Generated/oura_core.swift
#
# Requires macOS with Xcode and rustup.
set -euo pipefail

cd "$(dirname "$0")/../.."
IOS_DIR="apps/ios"
GENERATED="$IOS_DIR/OuraApp/Generated"
BUILD="target/ios-xcframework"

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  cargo build -p oura-core --release --target "$target"
done

# Swift bindings are generated from a host build of the same crate.
cargo build -p oura-core
rm -rf "$BUILD" "$GENERATED"
mkdir -p "$BUILD/headers" "$BUILD/sim" "$GENERATED"
cargo run -p oura-core --features bindgen --bin uniffi-bindgen -- \
  generate --library target/debug/liboura_core.dylib \
  --language swift --out-dir "$BUILD/bindings"

cp "$BUILD/bindings/oura_core.swift" "$GENERATED/"
cp "$BUILD/bindings/oura_coreFFI.h" "$BUILD/headers/"
# Xcode only picks up a module map named exactly `module.modulemap`.
cp "$BUILD/bindings/oura_coreFFI.modulemap" "$BUILD/headers/module.modulemap"

lipo -create \
  target/aarch64-apple-ios-sim/release/liboura_core.a \
  target/x86_64-apple-ios/release/liboura_core.a \
  -output "$BUILD/sim/liboura_core.a"

rm -rf "$IOS_DIR/OuraCore.xcframework"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/liboura_core.a -headers "$BUILD/headers" \
  -library "$BUILD/sim/liboura_core.a" -headers "$BUILD/headers" \
  -output "$IOS_DIR/OuraCore.xcframework"

echo "Built $IOS_DIR/OuraCore.xcframework and $GENERATED/oura_core.swift"
