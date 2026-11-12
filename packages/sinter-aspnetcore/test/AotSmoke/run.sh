#!/usr/bin/env bash
# The package as an app gets it: packed, restored from a local feed (its generator and MSBuild targets
# imported by NuGet), published with NativeAOT (a trim or AOT warning fails the build), and a page checked.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$here/../.."
work=$(mktemp -d)
version=$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$root/Directory.Build.props")
dotnet pack "$root/src/Sinter.AspNetCore" -c Release -o "$work/feed"
mkdir "$work/app"
cp "$here/Program.cs" "$work/app/"
cat > "$work/app/nuget.config" <<XML
<configuration>
  <packageSources>
    <add key="local" value="$work/feed" />
    <add key="nuget" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
XML
cat > "$work/app/AotSmoke.csproj" <<XML
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <PublishAot>true</PublishAot>
    <InvariantGlobalization>true</InvariantGlobalization>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <SinterBuild>$here/../Sinter.AspNetCore.Tests/fixtures/web</SinterBuild>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Tiaforge.Sinter.AspNetCore" Version="$version" />
  </ItemGroup>
</Project>
XML
dotnet publish "$work/app" -c Release -o "$work/out" -p:IlcTreatWarningsAsErrors=true
port=$((20000 + RANDOM % 20000))
"$work/out/AotSmoke" "$here/../Sinter.AspNetCore.Tests/fixtures/web" "$port" > "$work/log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 50); do curl -fs "http://127.0.0.1:$port/api/tags" >/dev/null && break; sleep 0.1; done
html=$(curl -fsS "http://127.0.0.1:$port/")
echo "$html"
grep -qF '<script type="application/json" data-sn="0">{"tags":["aot"]}</script>' <<<"$html"
grep -qF '<script type="application/json" data-sn="1">{"articles":["native"]}</script>' <<<"$html"
grep -qF '<script type="application/json" data-sn="2"></script>' <<<"$html"
echo "NativeAOT, from the package: ok ($(du -h "$work/out/AotSmoke" | cut -f1))"
