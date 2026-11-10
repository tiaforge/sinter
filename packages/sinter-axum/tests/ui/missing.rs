// `articles` has no request the build could describe, and no entry
// (trybuild compiles these in target/tests/trybuild/sinter-axum: the paths are from there)
fn main() {
    let _ = sinter_axum::embed!("../../../../tests/fixtures/web", { "user" => skip });
}
