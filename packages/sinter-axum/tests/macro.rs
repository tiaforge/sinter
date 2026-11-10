// embed!: the fixture build's placeholders checked against the resolvers when this test compiles.
use axum::{Router, body::Body, http::Request, routing::get};
use bytes::Bytes;
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn a_configuration_the_build_accepts_compiles_and_serves() {
    // `articles` has no request the build describes: without its entry this would not compile
    let embed = sinter_axum::embed!("tests/fixtures/web", {
        "articles" => |_req| async { Some(Bytes::from_static(br#"{"articles":[]}"#)) },
        "user" => skip,
    });
    let api = Router::new().route("/api/tags", get(|| async { ([("content-type", "application/json")], r#"{"tags":["a"]}"#) }));
    let app = Router::new().layer(embed.api(api).build().unwrap());
    let res = app.oneshot(Request::get("/").body(Body::empty()).unwrap()).await.unwrap();
    let html = String::from_utf8(res.into_body().collect().await.unwrap().to_bytes().to_vec()).unwrap();
    assert!(html.contains(r#"data-sn="0">{"tags":["a"]}</script>"#), "{html}");
    assert!(html.contains(r#"data-sn="1">{"articles":[]}</script>"#), "{html}");
    assert!(html.contains(r#"<script type="application/json" data-sn="2"></script>"#), "{html}");
}

#[test]
fn a_build_directory_from_another_build_is_refused() {
    let other = std::env::temp_dir().join(format!("sinter-axum-other-{}", std::process::id()));
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(other.join("sinter-embed.json"), r#"{ "version": 1, "pages": [] }"#).unwrap();
    let err =
        sinter_axum::embed!("tests/fixtures/web", { "articles" => skip, "user" => skip }).dir(&other).build().err().unwrap().to_string();
    assert!(err.contains("is not the build this binary was compiled against"), "{err}");
}

#[test]
fn compile_errors() {
    trybuild::TestCases::new().compile_fail("tests/ui/*.rs");
}
