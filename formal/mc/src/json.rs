//! Minimal JSON writer (strings, numbers, objects built by the caller).

pub(crate) fn string(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

pub(crate) fn opt_string(s: Option<&str>) -> String {
    s.map_or_else(|| "null".to_string(), string)
}

pub(crate) fn object(fields: &[(&str, String)]) -> String {
    let body: Vec<String> = fields.iter().map(|(k, v)| format!("{}:{}", string(k), v)).collect();
    format!("{{{}}}", body.join(","))
}

pub(crate) fn array(items: &[String]) -> String {
    format!("[{}]", items.join(","))
}

pub(crate) fn float(x: f64) -> String {
    if x.is_finite() { format!("{x:e}") } else { "null".to_string() }
}
