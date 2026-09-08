//! The bead, drawn at run time for the tray.
//!
//! The same decision nazar-tray took, for a smaller reason. There the icon carries state —
//! a fill that rises with the quota — so a pre-rendered set would have been hundreds of
//! images. Here it carries none: it is the mark, and it would be defensible to ship one
//! PNG per size. Drawing it is still better by a little, and the little is worth having:
//!
//! * **One scale factor, not four guesses.** Windows asks for the icon at whatever the
//!   primary display's scale factor implies, and a 16-pixel bead resampled from a
//!   32-pixel PNG looks like a smudge where a bead drawn at 16 looks like a bead.
//! * **No decoder in the binary.** `tauri`'s `image-png` feature is not enabled, so
//!   nothing in this application decodes an image format at run time.
//! * **The artwork is written once.** The grid below is `packages/ui/assets/nazar.svg`
//!   transcribed, and the tests at the bottom read that file and the design master beside
//!   it and fail if any of the three drift apart.
//!
//! **Direction 04 — the pixel bead.** The mark used to be four concentric circles and a
//! supersampler; it is now sixteen rows of sixteen cells, and the renderer is a lookup.
//! That is not only a change of style, it is what the tray wanted all along: at 16 pixels
//! every cell is exactly one device pixel, so what Windows shows is the artwork rather
//! than an approximation of it, and there is no antialiased fringe to go muddy against a
//! dark taskbar. `docs/design/README.md` has the six directions and why this one won.

/// The rim. `#0E2A5A`.
const DEEP_BLUE: [u8; 3] = [0x0E, 0x2A, 0x5A];
/// The band. `#FFFFFF`.
const WHITE: [u8; 3] = [0xFF, 0xFF, 0xFF];
/// The iris. `#3FA9F5`.
const LIGHT_BLUE: [u8; 3] = [0x3F, 0xA9, 0xF5];
/// The pupil. `#0A0A0F`.
const BLACK_DOT: [u8; 3] = [0x0A, 0x0A, 0x0F];

/// The grid's extent, in cells, on both axes. Also the tray's native pixel size.
pub const GRID: usize = 16;

/// The mark, one character a cell: `R` rim, `W` band, `I` iris, `P` pupil, `.` nothing.
///
/// Byte for byte the grid in `packages/ui/src/bead.ts`, which is
/// `docs/design/icon-04-pixel-bead.svg` transcribed. Three copies of one drawing, and
/// three tests that will not let them disagree.
const BEAD: [&[u8; GRID]; GRID] = [
    b"......RRRR......",
    b"....RRRRRRRR....",
    b"..RRRRWWWWRRRR..",
    b"..RRWWWWWWWWRR..",
    b".RRWWWWIIWWWWRR.",
    b".RRWWIIIIIIWWRR.",
    b"RRWWWIIIIIIWWWRR",
    b"RRWWIIIPPIIIWWRR",
    b"RRWWIIIPPIIIWWRR",
    b"RRWWWIIIIIIWWWRR",
    b".RRWWIIIIIIWWRR.",
    b".RRWWWWIIWWWWRR.",
    b"..RRWWWWWWWWRR..",
    b"..RRRRWWWWRRRR..",
    b"....RRRRRRRR....",
    b"......RRRR......",
];

/// Which of the two drawings of the mark to rasterise.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Variant {
    /// The four brand colours. What a Windows taskbar gets, in either theme.
    Colour,
    /// White where the mark has rim or iris, transparent everywhere else.
    ///
    /// This is `docs/design/icon-04-pixel-bead-mono.svg`: the structure is carried by the
    /// holes rather than by colour, so a host that tints a template icon to suit its own
    /// bar — macOS does, and inverts it for a light menu bar — still gets a bead. Windows
    /// has no such mechanism and takes the colour variant, which is the right answer
    /// there anyway: a white mark would vanish on a light taskbar.
    Template,
}

/// A rasterised icon: straight (non-premultiplied) RGBA, row-major.
pub struct Bitmap {
    /// Pixels, four bytes each.
    pub rgba: Vec<u8>,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels, always equal to the width.
    pub height: u32,
}

/// The icon size Windows wants at a given scale factor.
///
/// 16 logical pixels is the tray's own unit and the grid's own extent, so at 100 % every
/// cell is one device pixel and the icon is the artwork exactly. Everything else is that
/// scaled and rounded to an even number, because an odd width puts the bead's centre
/// between two pixels. At 125 % and 150 % — 20 and 24 pixels for 16 cells — a cell is one
/// pixel or two rather than a constant, which is uneven but still hard-edged; handing the
/// shell a size it did not ask for and letting it resample would be neither.
#[must_use]
pub fn size_for_scale(scale: f64) -> u32 {
    let raw = (16.0 * scale.max(1.0)).round().max(16.0);
    let even = (raw as u32).next_multiple_of(2);
    even.min(64)
}

/// The colour of a cell in a variant, or `None` where nothing is drawn.
const fn cell_colour(cell: u8, variant: Variant) -> Option<[u8; 3]> {
    match (variant, cell) {
        (Variant::Colour, b'R') => Some(DEEP_BLUE),
        (Variant::Colour, b'W') => Some(WHITE),
        (Variant::Colour, b'I') => Some(LIGHT_BLUE),
        (Variant::Colour, b'P') => Some(BLACK_DOT),
        // The template keeps the rim and the iris and drops the band and the pupil, so
        // the bead survives as ring / gap / ring / hole.
        (Variant::Template, b'R' | b'I') => Some(WHITE),
        _ => None,
    }
}

/// Draw the bead at `size` pixels square, in the four brand colours.
#[must_use]
pub fn render(size: u32) -> Bitmap {
    render_variant(size, Variant::Colour)
}

/// Draw the monochrome template at `size` pixels square.
#[must_use]
pub fn render_template(size: u32) -> Bitmap {
    render_variant(size, Variant::Template)
}

/// Draw one variant at `size` pixels square.
///
/// Nearest neighbour and nothing else: the cell a pixel belongs to is `x * 16 / size` in
/// integer arithmetic, so a pixel is inside exactly one cell and takes its colour whole.
/// No supersampling, no blending, no partial alpha — every pixel is opaque or absent,
/// which is the entire point of authoring on the grid rather than on circles.
#[must_use]
pub fn render_variant(size: u32, variant: Variant) -> Bitmap {
    let extent = size as usize;
    let grid = GRID as u32;
    let mut rgba = vec![0u8; extent * extent * 4];

    for y in 0..size {
        let row = BEAD[(y * grid / size) as usize];
        for x in 0..size {
            let Some(colour) = cell_colour(row[(x * grid / size) as usize], variant) else {
                continue;
            };
            let at = ((y as usize) * extent + (x as usize)) * 4;
            rgba[at] = colour[0];
            rgba[at + 1] = colour[1];
            rgba[at + 2] = colour[2];
            rgba[at + 3] = 0xFF;
        }
    }

    Bitmap {
        rgba,
        width: size,
        height: size,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse a pixel-bead SVG into the same sixteen strings the grid is written as.
    ///
    /// A deliberately small parser: the artwork is hand-authored files of
    /// `<rect x y width height fill>` on integer coordinates, and anything else appearing
    /// in one of them should fail this test rather than be quietly tolerated.
    fn grid_of(svg: &str, code: &dyn Fn(&str) -> Option<char>) -> Vec<String> {
        let mut cells = vec![vec!['.'; GRID]; GRID];
        for line in svg.lines() {
            let line = line.trim();
            if !line.starts_with("<rect ") {
                continue;
            }
            let value = |name: &str| -> String {
                let key = format!("{name}=\"");
                let start = line.find(&key).expect("attribute is present") + key.len();
                let rest = &line[start..];
                rest[..rest.find('"').expect("attribute is closed")].to_string()
            };
            let number = |name: &str| value(name).parse::<usize>().expect("integer attribute");
            let (x, y) = (number("x"), number("y"));
            let (width, height) = (number("width"), number("height"));
            let fill = value("fill").to_ascii_uppercase();
            let character = code(&fill).unwrap_or_else(|| panic!("unexpected fill {fill}"));
            for row in cells.iter_mut().skip(y).take(height) {
                for cell in row.iter_mut().skip(x).take(width) {
                    assert_eq!(*cell, '.', "two rects cover one cell");
                    *cell = character;
                }
            }
        }
        cells
            .into_iter()
            .map(|row| row.into_iter().collect())
            .collect()
    }

    /// A file in the repository, three directories above this crate.
    fn artwork(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is readable", path.display()))
    }

    /// The four brand hexes, as the grid's characters.
    fn colour_code(fill: &str) -> Option<char> {
        match fill {
            "#0E2A5A" => Some('R'),
            "#FFFFFF" => Some('W'),
            "#3FA9F5" => Some('I'),
            "#0A0A0F" => Some('P'),
            _ => None,
        }
    }

    #[test]
    fn the_bitmap_is_the_size_it_says_it_is() {
        let bitmap = render(32);
        assert_eq!(bitmap.width, 32);
        assert_eq!(bitmap.height, 32);
        assert_eq!(bitmap.rgba.len(), 32 * 32 * 4);
    }

    #[test]
    fn the_corners_are_transparent_and_the_centre_is_the_pupil() {
        let size = 32usize;
        let bitmap = render(32);
        let at = |x: usize, y: usize| {
            let i = (y * size + x) * 4;
            [
                bitmap.rgba[i],
                bitmap.rgba[i + 1],
                bitmap.rgba[i + 2],
                bitmap.rgba[i + 3],
            ]
        };
        assert_eq!(at(0, 0)[3], 0, "the mark does not reach the corner");
        assert_eq!(at(31, 31)[3], 0);

        let middle = at(size / 2, size / 2);
        assert_eq!(middle[3], 255, "the centre is opaque");
        assert_eq!([middle[0], middle[1], middle[2]], BLACK_DOT);
    }

    /// The opposite of what the round bead asserted, and the reason for the change: the
    /// old test demanded an antialiased rim, because a circle without one looks like a
    /// cog. A mark drawn on the grid must have no soft pixel anywhere, at any size.
    #[test]
    fn every_pixel_is_opaque_or_absent_and_never_in_between() {
        for size in [16, 20, 24, 32, 48, 64] {
            for variant in [Variant::Colour, Variant::Template] {
                let bitmap = render_variant(size, variant);
                let soft = bitmap
                    .rgba
                    .chunks_exact(4)
                    .filter(|pixel| pixel[3] != 0 && pixel[3] != 255)
                    .count();
                assert_eq!(
                    soft, 0,
                    "{soft} antialiased pixels at {size} px, {variant:?}"
                );
            }
        }
    }

    /// At the native size the render *is* the grid, cell for cell.
    #[test]
    fn sixteen_pixels_is_sixteen_cells() {
        let bitmap = render(16);
        for (y, row) in BEAD.iter().enumerate() {
            for (x, cell) in row.iter().enumerate() {
                let at = (y * GRID + x) * 4;
                let pixel = [bitmap.rgba[at], bitmap.rgba[at + 1], bitmap.rgba[at + 2]];
                let alpha = bitmap.rgba[at + 3];
                match cell_colour(*cell, Variant::Colour) {
                    Some(colour) => {
                        assert_eq!(alpha, 255, "cell {x},{y} should be drawn");
                        assert_eq!(pixel, colour, "cell {x},{y} is the wrong colour");
                    }
                    None => assert_eq!(alpha, 0, "cell {x},{y} should be empty"),
                }
            }
        }
    }

    /// The template is the colour bead's rim and iris, and nothing else.
    #[test]
    fn the_template_keeps_the_ring_and_drops_the_band() {
        let bitmap = render_template(16);
        for (y, row) in BEAD.iter().enumerate() {
            for (x, cell) in row.iter().enumerate() {
                let alpha = bitmap.rgba[(y * GRID + x) * 4 + 3];
                let wanted = matches!(cell, b'R' | b'I');
                assert_eq!(alpha == 255, wanted, "cell {x},{y} in the template");
            }
        }
    }

    #[test]
    fn the_size_follows_the_scale_factor_and_stays_even() {
        assert_eq!(size_for_scale(1.0), 16);
        assert_eq!(size_for_scale(1.25), 20);
        assert_eq!(size_for_scale(1.5), 24);
        assert_eq!(size_for_scale(2.0), 32);
        assert_eq!(
            size_for_scale(0.5),
            16,
            "never smaller than the tray's unit"
        );
        assert_eq!(size_for_scale(8.0), 64, "and never absurd");
        for scale in [1.0, 1.1, 1.25, 1.4, 1.5, 1.75, 2.0, 3.0] {
            assert_eq!(size_for_scale(scale) % 2, 0, "odd at {scale}");
        }
    }

    /// The grid here and the mark the canvas draws are one artwork written twice.
    #[test]
    fn the_grid_has_not_drifted_from_the_shipped_artwork() {
        let cells = grid_of(&artwork("packages/ui/assets/nazar.svg"), &colour_code);
        for (y, row) in cells.iter().enumerate() {
            assert_eq!(
                row.as_bytes(),
                BEAD[y].as_slice(),
                "row {y} of nazar.svg is not row {y} of the tray's grid"
            );
        }
    }

    /// And one artwork with the design master the maintainer picked, colour and template.
    #[test]
    fn the_grid_has_not_drifted_from_the_design_master() {
        let colour = grid_of(&artwork("docs/design/icon-04-pixel-bead.svg"), &colour_code);
        for (y, row) in colour.iter().enumerate() {
            assert_eq!(
                row.as_bytes(),
                BEAD[y].as_slice(),
                "row {y} of direction 04"
            );
        }

        let mono = grid_of(
            &artwork("docs/design/icon-04-pixel-bead-mono.svg"),
            &|fill| {
                if fill == "#FFFFFF" { Some('M') } else { None }
            },
        );
        for (y, row) in mono.iter().enumerate() {
            let wanted: String = BEAD[y]
                .iter()
                .map(|cell| {
                    if matches!(cell, b'R' | b'I') {
                        'M'
                    } else {
                        '.'
                    }
                })
                .collect();
            assert_eq!(*row, wanted, "row {y} of the template master");
        }
    }
}
