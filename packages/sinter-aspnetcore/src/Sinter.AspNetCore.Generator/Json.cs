// A small JSON reader for sinter-embed.json inside the compiler (netstandard2.0, no System.Text.Json):
// objects as Dictionary<string, object?>, arrays as List<object?>, numbers as double, strings, bools, null.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Sinter.AspNetCore.Generator;

internal sealed class JsonException(string message) : Exception(message);

internal static class Json
{
    public static object? Parse(string text)
    {
        var i = 0;
        if (text.Length > 0 && text[0] == '\uFEFF') i = 1;
        var v = Value(text, ref i);
        Ws(text, ref i);
        if (i != text.Length) throw new JsonException($"unexpected `{text[i]}` at {i}");
        return v;
    }

    private static void Ws(string s, ref int i)
    {
        while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
    }

    private static object? Value(string s, ref int i)
    {
        Ws(s, ref i);
        if (i >= s.Length) throw new JsonException("unexpected end");
        switch (s[i])
        {
            case '{':
            {
                i++;
                var o = new Dictionary<string, object?>();
                Ws(s, ref i);
                if (i < s.Length && s[i] == '}') { i++; return o; }
                while (true)
                {
                    Ws(s, ref i);
                    if (i >= s.Length || s[i] != '"') throw new JsonException($"expected a name at {i}");
                    var k = Str(s, ref i);
                    Ws(s, ref i);
                    if (i >= s.Length || s[i] != ':') throw new JsonException($"expected `:` at {i}");
                    i++;
                    o[k] = Value(s, ref i);
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == '}') { i++; return o; }
                    throw new JsonException($"expected `,` or `}}` at {i}");
                }
            }
            case '[':
            {
                i++;
                var a = new List<object?>();
                Ws(s, ref i);
                if (i < s.Length && s[i] == ']') { i++; return a; }
                while (true)
                {
                    a.Add(Value(s, ref i));
                    Ws(s, ref i);
                    if (i < s.Length && s[i] == ',') { i++; continue; }
                    if (i < s.Length && s[i] == ']') { i++; return a; }
                    throw new JsonException($"expected `,` or `]` at {i}");
                }
            }
            case '"':
                return Str(s, ref i);
            case 't':
                Word(s, ref i, "true");
                return true;
            case 'f':
                Word(s, ref i, "false");
                return false;
            case 'n':
                Word(s, ref i, "null");
                return null;
            default:
            {
                var start = i;
                while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
                if (start == i || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                    throw new JsonException($"unexpected `{s[start]}` at {start}");
                return d;
            }
        }
    }

    private static void Word(string s, ref int i, string w)
    {
        if (string.CompareOrdinal(s, i, w, 0, w.Length) != 0) throw new JsonException($"unexpected `{s[i]}` at {i}");
        i += w.Length;
    }

    private static string Str(string s, ref int i)
    {
        i++;
        var b = new StringBuilder();
        while (true)
        {
            if (i >= s.Length) throw new JsonException("unterminated string");
            var c = s[i++];
            if (c == '"') return b.ToString();
            if (c != '\\') { b.Append(c); continue; }
            if (i >= s.Length) throw new JsonException("unterminated string");
            var e = s[i++];
            switch (e)
            {
                case '"': b.Append('"'); break;
                case '\\': b.Append('\\'); break;
                case '/': b.Append('/'); break;
                case 'b': b.Append('\b'); break;
                case 'f': b.Append('\f'); break;
                case 'n': b.Append('\n'); break;
                case 'r': b.Append('\r'); break;
                case 't': b.Append('\t'); break;
                case 'u':
                    if (i + 4 > s.Length) throw new JsonException("bad escape");
                    b.Append((char)int.Parse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                    i += 4;
                    break;
                default: throw new JsonException($"bad escape `\\{e}`");
            }
        }
    }
}
