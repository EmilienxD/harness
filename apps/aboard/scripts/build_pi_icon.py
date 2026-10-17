"""Generate Aboard's original Pi product-icon font.

Regenerate with: uv run --with fonttools python apps/aboard/scripts/build_pi_icon.py
FontTools is a generation-only dependency, not an extension dependency.
"""
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen


def pi_glyph():
    pen = TTGlyphPen(None)
    # A top bar and two descending legs, in a 1024-unit icon square.
    pen.moveTo((128, 704))
    pen.lineTo((896, 704))
    pen.lineTo((896, 608))
    pen.lineTo((720, 608))
    pen.lineTo((720, 288))
    pen.qCurveTo((720, 192), (832, 240))
    pen.lineTo((864, 152))
    pen.qCurveTo((624, 48), (624, 288))
    pen.lineTo((624, 608))
    pen.lineTo((384, 608))
    pen.lineTo((352, 128))
    pen.lineTo((256, 128))
    pen.lineTo((288, 608))
    pen.lineTo((128, 608))
    pen.closePath()
    return pen.glyph()


font = FontBuilder(1024, isTTF=True)
font.setupGlyphOrder([".notdef", "pi"])
font.setupCharacterMap({0xE001: "pi"})
font.setupGlyf({".notdef": TTGlyphPen(None).glyph(), "pi": pi_glyph()})
font.setupHorizontalMetrics({".notdef": (1024, 0), "pi": (1024, 128)})
font.setupHorizontalHeader(ascent=896, descent=-128)
font.setupNameTable({"familyName": "Aboard Icons", "styleName": "Regular", "uniqueFontIdentifier": "Aboard Icons Regular 1.0", "fullName": "Aboard Icons", "psName": "AboardIcons", "version": "Version 1.0"})
font.setupOS2(sTypoAscender=896, sTypoDescender=-128, usWinAscent=896, usWinDescent=128)
font.setupPost()
font.setupMaxp()
font.save(Path(__file__).resolve().parents[1] / "assets" / "pi-icon.ttf")
