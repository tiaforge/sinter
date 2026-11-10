// the frontend is not built
// (trybuild compiles these in target/tests/trybuild/sinter-axum: the paths are from there)
fn main() {
    let _ = sinter_axum::embed!("../../../../tests/fixtures/none", {});
}
