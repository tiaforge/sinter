// a name no placeholder has (a typo)
// (trybuild compiles these in target/tests/trybuild/sinter-axum: the paths are from there)
fn main() {
    let _ = sinter_axum::embed!("../../../../../../test/fixtures/server-build", { "articles" => skip, "usr" => skip });
}
