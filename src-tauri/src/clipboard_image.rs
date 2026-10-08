//! 剪贴板位图 → PNG（第四阶段块 B）。
//! 格式优先级：CF_PNG（注册格式，原始字节直落盘）> CF_DIBV5 > CF_DIB。
//! DIB 解析自实现（clipboard-win 5 仅提供原始字节读取，无位图解码）：
//! BITMAPINFOHEADER(40)/V4(108)/V5(124) + BI_RGB / BI_BITFIELDS，24/32bpp，
//! top-down/bottom-up 行序。选型说明：image crate 全解码器全家桶远重于需求，
//! 自解析 100 行内可控；PNG 编码引 png crate（最小够用）。
//! Alpha 策略：仅在显式 alpha mask（V4/V5 header 或 BI_BITFIELDS 提供）时采用，
//! 32bpp BI_RGB 的 alpha 字节视为未定义置 255 —— 防止 PrintScreen 类源的
//! 垃圾 alpha 把整图变透明；Win+Shift+S 截图的 CF_DIBV5 带 V5 mask，透明保留。

use clipboard_win::formats::{self, RawData};
use clipboard_win::{get_clipboard, is_format_avail, register_format};

/// PNG 文件魔数
const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// 读取剪贴板图片并转成 PNG 字节；无图返回 None（不视为错误）。
pub fn read_image_png() -> Option<Vec<u8>> {
    // 1. CF_PNG：注册格式名 "PNG"（浏览器/部分截图工具直存）
    if let Some(id) = register_format("PNG") {
        if is_format_avail(id.get()) {
            if let Ok(bytes) = get_clipboard(RawData(id.get())) {
                if bytes.len() > 8 && bytes[..8] == PNG_MAGIC {
                    return Some(bytes);
                }
            }
        }
    }
    // 2. DIB 系（CF_DIBV5 优先于 CF_DIB：带 V5 alpha mask 的可能性更高）
    for cf in [formats::CF_DIBV5, formats::CF_DIB] {
        if !is_format_avail(cf) {
            continue;
        }
        if let Ok(dib) = get_clipboard(RawData(cf)) {
            if let Some(png) = dib_to_png(&dib) {
                return Some(png);
            }
        }
    }
    None
}

fn le_u32(dib: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(dib.get(offset..offset + 4)?.try_into().ok()?))
}

fn le_i32(dib: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(dib.get(offset..offset + 4)?.try_into().ok()?))
}

/// DIB（BITMAPINFO 起始）→ PNG（RGBA8）。结构异常/不支持格式返回 None。
fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let header_size = le_u32(dib, 0)? as usize;
    let width = le_i32(dib, 4)?;
    let height_raw = le_i32(dib, 8)?;
    let bit_count = u16::from_le_bytes(dib.get(14..16)?.try_into().ok()?) as u32;
    let compression = le_u32(dib, 16)?;

    if width <= 0 || height_raw == 0 || width > 32767 || height_raw.unsigned_abs() > 32767 {
        return None;
    }
    let height = height_raw.unsigned_abs();
    let top_down = height_raw < 0;
    if !matches!(bit_count, 24 | 32) {
        return None; // 调色板/16bpp 场景非截图主流，不支持
    }
    if !matches!(compression, 0 | 3) {
        return None; // BI_RGB / BI_BITFIELDS 之外（RLE 等）不支持
    }

    // 通道 masks：V4/V5 header 自含；40 字节 header + BI_BITFIELDS 时紧跟 header
    // （标准 12 字节 R/G/B；个别源额外带 4 字节 alpha mask，读到则一并采用）；
    // BI_RGB 标准布局（小端像素：B,G,R,[x]）
    const BGRA: (u32, u32, u32) = (0x00FF_0000, 0x0000_FF00, 0x0000_00FF);
    let (r_mask, g_mask, b_mask, a_mask, masks_size) = if header_size >= 108 {
        let (r, g, b) = (le_u32(dib, 40)?, le_u32(dib, 44)?, le_u32(dib, 48)?);
        let (r, g, b) = if r == 0 || g == 0 || b == 0 { BGRA } else { (r, g, b) };
        (r, g, b, le_u32(dib, 52)?, 0usize)
    } else if compression == 3 {
        let base = header_size;
        let r = le_u32(dib, base)?;
        let g = le_u32(dib, base + 4)?;
        let b = le_u32(dib, base + 8)?;
        let a = if dib.len() >= base + 16 { le_u32(dib, base + 12)? } else { 0 };
        (r, g, b, a, usize::from(a != 0) * 16 + usize::from(a == 0) * 12)
    } else {
        (BGRA.0, BGRA.1, BGRA.2, 0, 0usize)
    };

    // 像素数据偏移：header + 紧随的 masks（颜色表：24/32bpp 为 0）
    let pixel_offset = header_size + masks_size;
    let px_bytes = (bit_count / 8) as usize;
    let stride = (width as usize * px_bytes + 3) / 4 * 4;
    let needed = pixel_offset.checked_add(stride.checked_mul(height as usize)?)?;
    if dib.len() < needed {
        return None;
    }

    let use_alpha = bit_count == 32 && a_mask != 0;
    let w = width as usize;
    let mut rgba = vec![255u8; w * height as usize * 4];
    for y in 0..height as usize {
        let src_y = if top_down { y } else { height as usize - 1 - y };
        let row_start = pixel_offset + src_y * stride;
        for x in 0..w {
            let off = row_start + x * px_bytes;
            let pixel = if bit_count == 32 {
                u32::from_le_bytes(dib[off..off + 4].try_into().ok()?)
            } else {
                u32::from_le_bytes([dib[off], dib[off + 1], dib[off + 2], 0])
            };
            let dst = (y * w + x) * 4;
            rgba[dst] = extract_channel(pixel, r_mask);
            rgba[dst + 1] = extract_channel(pixel, g_mask);
            rgba[dst + 2] = extract_channel(pixel, b_mask);
            if use_alpha {
                rgba[dst + 3] = extract_channel(pixel, a_mask);
            }
        }
    }

    let mut out = Vec::with_capacity(rgba.len());
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(out)
}

/// mask → 通道值（缩放到 0..=255；mask 为 0 返回 0）
fn extract_channel(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let bits = (mask >> shift).trailing_ones(); // mask 内连续 1 的宽度
    let max = (1u32 << bits) - 1;
    let v = (pixel >> shift) & max;
    (((v * 255) + max / 2) / max) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造 BITMAPINFOHEADER(40) 的 DIB；compression 0=BI_RGB
    fn bmi_header(width: i32, height: i32, bpp: u16, compression: u32) -> Vec<u8> {
        let mut h = vec![0u8; 40];
        h[0..4].copy_from_slice(&40u32.to_le_bytes());
        h[4..8].copy_from_slice(&(width as u32).to_le_bytes());
        h[8..12].copy_from_slice(&(height as i32).to_le_bytes());
        h[12..14].copy_from_slice(&1u16.to_le_bytes());
        h[14..16].copy_from_slice(&bpp.to_le_bytes());
        h[16..20].copy_from_slice(&compression.to_le_bytes());
        h
    }

    /// 32bpp 像素内存序 = B,G,R,A；断言 PNG 解回后的 RGBA
    fn decode_rgba(png_bytes: &[u8]) -> Vec<(u8, u8, u8, u8)> {
        let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
        let mut reader = decoder.read_info().expect("合法 PNG");
        let mut buf = vec![0u8; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).expect("解码成功");
        assert_eq!(info.color_type, png::ColorType::Rgba);
        buf[..info.buffer_size()]
            .chunks_exact(4)
            .map(|c| (c[0], c[1], c[2], c[3]))
            .collect()
    }

    #[test]
    fn bi_rgb_32bpp_bottom_up_alpha_forced_opaque() {
        // 2x1：像素1 = 红不透明（alpha 字节 0xFF），像素2 = 蓝但 alpha 字节 0（垃圾）
        let mut dib = bmi_header(2, 1, 32, 0);
        dib.extend_from_slice(&[255, 0, 0, 255]); // B=0 G=0 R=255 A=255（bottom-up 第一行 = 像素2）
        dib.extend_from_slice(&[0, 0, 255, 0]); // B=255 R=0 A=0
        let png = dib_to_png(&dib).expect("转换成功");
        let rgba = decode_rgba(&png);
        // bottom-up 反转后：第一像素为原第二行（蓝），alpha 垃圾字节强制 255
        assert_eq!(rgba, vec![(0, 0, 255, 255), (255, 0, 0, 255)]);
    }

    #[test]
    fn v5_header_preserves_real_alpha() {
        // BITMAPV5HEADER(124) + 显式 alphaMask 0xFF000000：透明通道保留（截图透明部分不发黑）
        let mut dib = bmi_header(1, 1, 32, 0);
        dib.resize(124, 0);
        dib[0..4].copy_from_slice(&124u32.to_le_bytes());
        dib[40..44].copy_from_slice(&0x00FF_0000u32.to_le_bytes()); // red
        dib[44..48].copy_from_slice(&0x0000_FF00u32.to_le_bytes()); // green
        dib[48..52].copy_from_slice(&0x0000_00FFu32.to_le_bytes()); // blue
        dib[52..56].copy_from_slice(&0xFF00_0000u32.to_le_bytes()); // alpha
        // 半透明红：B=0 G=0 R=255 A=128
        dib.extend_from_slice(&[0, 0, 255, 128]);
        let png = dib_to_png(&dib).expect("转换成功");
        let rgba = decode_rgba(&png);
        assert_eq!(rgba, vec![(255, 0, 0, 128)]);
    }

    #[test]
    fn negative_height_means_top_down() {
        // height = -1：单行，行序不反转
        let mut dib = bmi_header(1, -1, 32, 0);
        dib.extend_from_slice(&[0, 255, 0, 255]); // 绿
        let png = dib_to_png(&dib).expect("转换成功");
        assert_eq!(decode_rgba(&png), vec![(0, 255, 0, 255)]);
    }

    #[test]
    fn bi_rgb_24bpp_expands_to_rgba() {
        // 2x1 24bpp（行对齐 4 字节：2 像素 6 字节 + 2 填充）
        let mut dib = bmi_header(2, 1, 24, 0);
        dib.extend_from_slice(&[255, 0, 0]); // B=255（蓝）
        dib.extend_from_slice(&[0, 0, 255]); // R=255（红）
        dib.extend_from_slice(&[0, 0]); // padding
        let png = dib_to_png(&dib).expect("转换成功");
        let rgba = decode_rgba(&png);
        assert_eq!(rgba, vec![(0, 0, 255, 255), (255, 0, 0, 255)]);
    }

    #[test]
    fn bitfields_masks_40b_header_take_alpha_from_trailing_mask() {
        // 40 字节 header + BI_BITFIELDS：masks 紧跟 header（12 字节 + 4 字节 alpha）
        let mut dib = bmi_header(1, 1, 32, 3);
        dib.extend_from_slice(&0x00FF_0000u32.to_le_bytes()); // R
        dib.extend_from_slice(&0x0000_FF00u32.to_le_bytes()); // G
        dib.extend_from_slice(&0x0000_00FFu32.to_le_bytes()); // B
        dib.extend_from_slice(&0xFF00_0000u32.to_le_bytes()); // A
        dib.extend_from_slice(&[0, 0, 255, 64]); // 红，alpha 64
        let png = dib_to_png(&dib).expect("转换成功");
        assert_eq!(decode_rgba(&png), vec![(255, 0, 0, 64)]);
    }

    #[test]
    fn rejects_rle_and_truncated_data() {
        // RLE 压缩不支持
        let dib = bmi_header(1, 1, 32, 1);
        assert!(dib_to_png(&dib).is_none());
        // 像素数据截断
        let mut dib = bmi_header(4, 4, 32, 0);
        dib.truncate(40 + 16); // 需要 40 + 4*4*4 = 104
        assert!(dib_to_png(&dib).is_none());
        // 调色板格式不支持
        let dib8 = bmi_header(1, 1, 8, 0);
        assert!(dib_to_png(&dib8).is_none());
    }
}
