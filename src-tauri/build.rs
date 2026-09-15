//! Build script.
//!
//! Besides driving `tauri-build`, it generates the application icons. Generating
//! them procedurally keeps the repository free of committed binaries and means a
//! fresh clone can build the Windows app without any extra tooling.

use std::fs;
use std::path::{Path, PathBuf};

const ICO_SIZES: [u32; 6] = [16, 32, 48, 64, 128, 256];
const PNG_SIZES: [(&str, u32); 3] = [
    ("32x32.png", 32),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
];

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let icons_dir = manifest_dir.join("icons");
    if let Err(err) = ensure_icons(&icons_dir) {
        // A missing icon must not break the build: the app still runs, it just
        // falls back to the default window icon.
        println!("cargo:warning=生成图标失败：{err}");
    }

    tauri_build::build()
}

fn ensure_icons(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;

    let ico_path = dir.join("icon.ico");
    if !ico_path.exists() {
        fs::write(&ico_path, build_ico())?;
    }

    for (name, size) in PNG_SIZES {
        let path = dir.join(name);
        if !path.exists() {
            fs::write(&path, encode_png(&render_icon(size), size, size))?;
        }
    }

    let app_png = dir.join("icon.png");
    if !app_png.exists() {
        let size = 512;
        fs::write(&app_png, encode_png(&render_icon(size), size, size))?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Icon artwork
// ---------------------------------------------------------------------------

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    if edge0 == edge1 {
        return if x < edge0 { 0.0 } else { 1.0 };
    }
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Signed distance to a rounded rectangle centred on the origin.
fn rounded_rect_distance(x: f32, y: f32, half: f32, radius: f32) -> f32 {
    let qx = x.abs() - (half - radius);
    let qy = y.abs() - (half - radius);
    let dx = qx.max(0.0);
    let dy = qy.max(0.0);
    (dx * dx + dy * dy).sqrt() + qx.max(qy).min(0.0) - radius
}

/// A rounded gradient tile with a keyhole: the visual shorthand for "local,
/// encrypted credentials".
fn coverage(px: f32, py: f32, size: f32) -> (f32, f32, f32, f32) {
    let center = size / 2.0;
    let x = px - center;
    let y = py - center;
    let half = size * 0.44;
    let radius = size * 0.24;

    let tile = 1.0 - smoothstep(-0.7, 0.7, rounded_rect_distance(x, y, half, radius));

    // Vertical gradient background.
    let t = ((py / size) - 0.1).clamp(0.0, 1.0);
    let top = (0.30_f32, 0.47_f32, 0.96_f32);
    let bottom = (0.16_f32, 0.28_f32, 0.74_f32);
    let mut r = lerp(top.0, bottom.0, t);
    let mut g = lerp(top.1, bottom.1, t);
    let mut b = lerp(top.2, bottom.2, t);

    // Keyhole: circle plus a tapered stem.
    let hole_center_y = center - size * 0.10;
    let hole_radius = size * 0.115;
    let hole = 1.0
        - smoothstep(
            hole_radius - size * 0.012,
            hole_radius + size * 0.012,
            (x * x + (py - hole_center_y).powi(2)).sqrt(),
        );

    let stem_top = hole_center_y + hole_radius * 0.35;
    let stem_bottom = center + size * 0.20;
    let stem_half_width_top = size * 0.052;
    let stem_half_width_bottom = size * 0.088;
    let in_stem_band = smoothstep(stem_top - 1.0, stem_top + 1.0, py)
        * (1.0 - smoothstep(stem_bottom - 1.0, stem_bottom + 1.0, py));
    let band = ((py - stem_top) / (stem_bottom - stem_top)).clamp(0.0, 1.0);
    let stem_half_width = lerp(stem_half_width_top, stem_half_width_bottom, band);
    let stem = in_stem_band
        * (1.0 - smoothstep(stem_half_width - 0.8, stem_half_width + 0.8, x.abs()));

    let key_shape = hole.max(stem).clamp(0.0, 1.0);
    r = lerp(r, 1.0, key_shape);
    g = lerp(g, 1.0, key_shape);
    b = lerp(b, 1.0, key_shape);

    // Subtle top-left highlight so the tile does not read as a flat sticker.
    let highlight = (1.0 - smoothstep(0.0, size * 0.9, (x * x + y * y).sqrt())) * 0.10;
    r = (r + highlight).min(1.0);
    g = (g + highlight).min(1.0);
    b = (b + highlight).min(1.0);

    (r, g, b, tile)
}

/// Renders the icon with 4x4 supersampling for smooth edges.
fn render_icon(size: u32) -> Vec<u8> {
    let size = size.max(8);
    let mut out = vec![0u8; (size * size * 4) as usize];
    let samples = 4u32;
    for py in 0..size {
        for px in 0..size {
            let mut acc = (0.0_f32, 0.0_f32, 0.0_f32, 0.0_f32);
            for sy in 0..samples {
                for sx in 0..samples {
                    let fx = px as f32 + (sx as f32 + 0.5) / samples as f32;
                    let fy = py as f32 + (sy as f32 + 0.5) / samples as f32;
                    let (r, g, b, a) = coverage(fx, fy, size as f32);
                    acc.0 += r * a;
                    acc.1 += g * a;
                    acc.2 += b * a;
                    acc.3 += a;
                }
            }
            let total = (samples * samples) as f32;
            let alpha = acc.3 / total;
            let (r, g, b) = if acc.3 > 0.0 {
                (acc.0 / acc.3, acc.1 / acc.3, acc.2 / acc.3)
            } else {
                (0.0, 0.0, 0.0)
            };
            let index = ((py * size + px) * 4) as usize;
            out[index] = to_byte(r);
            out[index + 1] = to_byte(g);
            out[index + 2] = to_byte(b);
            out[index + 3] = to_byte(alpha);
        }
    }
    out
}

fn to_byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0).round() as u8
}

// ---------------------------------------------------------------------------
// ICO container (uncompressed 32bpp DIB entries)
// ---------------------------------------------------------------------------

fn build_ico() -> Vec<u8> {
    let images: Vec<(u32, Vec<u8>)> = ICO_SIZES
        .iter()
        .map(|size| (*size, dib_bytes(&render_icon(*size), *size)))
        .collect();

    let mut out: Vec<u8> = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());

    let mut offset = 6 + 16 * images.len() as u32;
    for (size, data) in &images {
        let dimension = if *size >= 256 { 0u8 } else { *size as u8 };
        out.push(dimension);
        out.push(dimension);
        out.push(0);
        out.push(0);
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += data.len() as u32;
    }

    for (_, data) in &images {
        out.extend_from_slice(data);
    }
    out
}

/// BITMAPINFOHEADER + bottom-up BGRA pixels + 1bpp AND mask (all opaque).
fn dib_bytes(rgba: &[u8], size: u32) -> Vec<u8> {
    let pixel_bytes = (size * size * 4) as usize;
    let mask_stride = ((size + 31) / 32 * 4) as usize;
    let mask_bytes = mask_stride * size as usize;

    let mut out: Vec<u8> = Vec::with_capacity(40 + pixel_bytes + mask_bytes);
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(size as i32).to_le_bytes());
    out.extend_from_slice(&((size * 2) as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for row in (0..size).rev() {
        for col in 0..size {
            let index = ((row * size + col) * 4) as usize;
            out.push(rgba[index + 2]);
            out.push(rgba[index + 1]);
            out.push(rgba[index]);
            out.push(rgba[index + 3]);
        }
    }
    out.resize(out.len() + mask_bytes, 0);
    out
}

// ---------------------------------------------------------------------------
// PNG encoder (stored deflate blocks — no compression dependency needed)
// ---------------------------------------------------------------------------

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut raw: Vec<u8> = Vec::with_capacity((height * (width * 4 + 1)) as usize);
    for row in 0..height {
        raw.push(0); // filter type 0 (None)
        let start = (row * width * 4) as usize;
        raw.extend_from_slice(&rgba[start..start + (width * 4) as usize]);
    }

    let mut out: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr: Vec<u8> = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // colour type: RGBA
    ihdr.push(0);
    ihdr.push(0);
    ihdr.push(0);
    push_chunk(&mut out, b"IHDR", &ihdr);
    push_chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    push_chunk(&mut out, b"IEND", &[]);
    out
}

fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], payload: &[u8]) {
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(payload);
    let mut crc_input = Vec::with_capacity(4 + payload.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(payload);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// zlib stream using only "stored" deflate blocks, so no compressor is needed.
fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out: Vec<u8> = vec![0x78, 0x01];
    let mut offset = 0usize;
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xFF, 0xFF]);
    }
    while offset < data.len() {
        let remaining = data.len() - offset;
        let take = remaining.min(65_535);
        let last = offset + take >= data.len();
        out.push(if last { 0x01 } else { 0x00 });
        out.extend_from_slice(&(take as u16).to_le_bytes());
        out.extend_from_slice(&(!(take as u16)).to_le_bytes());
        out.extend_from_slice(&data[offset..offset + take]);
        offset += take;
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let mut a: u32 = 1;
    let mut b: u32 = 0;
    for byte in data {
        a = (a + *byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ico_header_is_well_formed() {
        let ico = build_ico();
        assert_eq!(u16::from_le_bytes([ico[0], ico[1]]), 0);
        assert_eq!(u16::from_le_bytes([ico[2], ico[3]]), 1);
        assert_eq!(
            u16::from_le_bytes([ico[4], ico[5]]) as usize,
            ICO_SIZES.len()
        );
    }

    #[test]
    fn png_starts_with_the_signature() {
        let png = encode_png(&render_icon(16), 16, 16);
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
    }

    #[test]
    fn adler_and_crc_match_known_values() {
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }
}
