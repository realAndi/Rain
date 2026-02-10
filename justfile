# Rain terminal development commands

# Run in development mode
dev:
    npm run tauri dev

# Build for production
build:
    npm run tauri build

# Install all dependencies
install:
    npm install

# Run Rust formatting
fmt:
    cd src-tauri && cargo fmt

# Run Rust linting
clippy:
    cd src-tauri && cargo clippy -- -W warnings

# Run Rust tests
test:
    cd src-tauri && cargo test

# Check Rust compilation without building
check:
    cd src-tauri && cargo check

# Run dependency audit
audit:
    cd src-tauri && cargo audit
    npm audit

# Clean build artifacts
clean:
    cd src-tauri && cargo clean
    rm -rf dist node_modules
