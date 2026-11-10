// a name no placeholder has (a typo)
// (trybuild compiles these in target/tests/trybuild/sinter-axum: the paths are from there)
fn main() {
    let _ = sinter_axum::embed!("../../../../tests/fixtures/web", { "articles" => skip, "usr" => skip });
}
