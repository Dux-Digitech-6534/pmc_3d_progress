"""Builds "3D Model and BOQ - Data Format" PDF for the PMC Progress application.

Run (WSL venv with reportlab): python make_format_pdf.py <out.pdf>
"""
import sys
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.platypus import (CondPageBreak, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle)

OUT = sys.argv[1]
NAVY = colors.HexColor('#1F3A5F')
TEAL = colors.HexColor('#0F766E')
LIGHT = colors.HexColor('#EEF3F8')
REQ = colors.HexColor('#FDECEC')
GRID = colors.HexColor('#C9D3DE')
GREY = colors.HexColor('#5B6573')

ss = getSampleStyleSheet()
H1 = ParagraphStyle('H1', parent=ss['Heading1'], fontName='Helvetica-Bold', fontSize=15, textColor=NAVY, spaceBefore=10, spaceAfter=6)
H2 = ParagraphStyle('H2', parent=ss['Heading2'], fontName='Helvetica-Bold', fontSize=11.5, textColor=TEAL, spaceBefore=8, spaceAfter=4)
P = ParagraphStyle('P', parent=ss['BodyText'], fontName='Helvetica', fontSize=9.5, leading=13.5, spaceAfter=5, alignment=TA_LEFT)
SMALL = ParagraphStyle('S', parent=P, fontSize=8.5, leading=11.5, textColor=GREY)
CELL = ParagraphStyle('C', parent=P, fontSize=8.3, leading=10.8, spaceAfter=0)
CELLB = ParagraphStyle('CB', parent=CELL, fontName='Helvetica-Bold')
HEAD = ParagraphStyle('HD', parent=CELL, fontName='Helvetica-Bold', textColor=colors.white)
BUL = ParagraphStyle('B', parent=P, leftIndent=12, bulletIndent=2, spaceAfter=2)

W = A4[0] - 36 * mm


def p(t, s=P):
    return Paragraph(t, s)


def bullets(items):
    return [Paragraph(t, BUL, bulletText='•') for t in items]


def table(head, rows, widths, req_rows=(), zebra=True):
    data = [[Paragraph(h, HEAD) for h in head]] + [[Paragraph(str(c), CELLB if j == 0 else CELL) for j, c in enumerate(r)] for r in rows]
    t = Table(data, colWidths=[w * W for w in widths], repeatRows=1)
    st = [
        ('BACKGROUND', (0, 0), (-1, 0), NAVY),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('GRID', (0, 0), (-1, -1), 0.5, GRID),
        ('TOPPADDING', (0, 0), (-1, -1), 3.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 3.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
    ]
    if zebra:
        for i in range(1, len(data)):
            if i % 2 == 0:
                st.append(('BACKGROUND', (0, i), (-1, i), LIGHT))
    for i in req_rows:
        st.append(('BACKGROUND', (0, i + 1), (0, i + 1), REQ))
    t.setStyle(TableStyle(st))
    return t


def note(text, color=LIGHT):
    t = Table([[Paragraph(text, P)]], colWidths=[W])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), color), ('BOX', (0, 0), (-1, -1), 0.6, GRID),
                           ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
                           ('TOPPADDING', (0, 0), (-1, -1), 6), ('BOTTOMPADDING', (0, 0), (-1, -1), 6)]))
    return t


def axes_figure():
    """Plan view (X, Y, centre, Length, Width) and elevation (Bottom, Height)."""
    d = Drawing(W, 62 * mm)
    ox, oy = 14 * mm, 10 * mm
    # plan
    d.add(String(ox, 57 * mm, 'PLAN VIEW', fontName='Helvetica-Bold', fontSize=8, fillColor=NAVY))
    d.add(Line(ox, oy, ox + 70 * mm, oy, strokeColor=GREY))
    d.add(Line(ox, oy, ox, oy + 42 * mm, strokeColor=GREY))
    d.add(Polygon([ox + 70 * mm, oy, ox + 67 * mm, oy + 1.2 * mm, ox + 67 * mm, oy - 1.2 * mm], fillColor=GREY, strokeColor=GREY))
    d.add(Polygon([ox, oy + 42 * mm, ox - 1.2 * mm, oy + 39 * mm, ox + 1.2 * mm, oy + 39 * mm], fillColor=GREY, strokeColor=GREY))
    d.add(String(ox + 71 * mm, oy - 1 * mm, 'X', fontName='Helvetica-Bold', fontSize=9))
    d.add(String(ox - 1 * mm, oy + 43.5 * mm, 'Y', fontName='Helvetica-Bold', fontSize=9))
    d.add(String(ox - 9 * mm, oy - 4 * mm, 'Origin (0,0)', fontName='Helvetica', fontSize=6.5, fillColor=GREY))
    bx, by, bw, bh = ox + 28 * mm, oy + 14 * mm, 28 * mm, 14 * mm
    d.add(Rect(bx, by, bw, bh, fillColor=colors.HexColor('#D7E6F5'), strokeColor=NAVY, strokeWidth=1))
    cx, cy = bx + bw / 2, by + bh / 2
    d.add(Rect(cx - 0.8 * mm, cy - 0.8 * mm, 1.6 * mm, 1.6 * mm, fillColor=colors.red, strokeColor=colors.red))
    d.add(String(cx - 8 * mm, cy - 5 * mm, 'centre (X, Y)', fontName='Helvetica', fontSize=7, fillColor=colors.red))
    d.add(Line(bx, by - 3 * mm, bx + bw, by - 3 * mm, strokeColor=TEAL))
    d.add(String(bx + bw / 2 - 8 * mm, by - 7 * mm, 'Length (along X)', fontName='Helvetica', fontSize=7, fillColor=TEAL))
    d.add(Line(bx + bw + 3 * mm, by, bx + bw + 3 * mm, by + bh, strokeColor=TEAL))
    d.add(String(bx + bw + 4.5 * mm, by + bh / 2 - 1 * mm, 'Width (along Y)', fontName='Helvetica', fontSize=7, fillColor=TEAL))
    # elevation
    ex, ey = ox + 105 * mm, oy
    d.add(String(ex, 57 * mm, 'ELEVATION', fontName='Helvetica-Bold', fontSize=8, fillColor=NAVY))
    d.add(Line(ex - 4 * mm, ey + 12 * mm, ex + 55 * mm, ey + 12 * mm, strokeColor=GREY, strokeDashArray=[3, 2]))
    d.add(String(ex + 38 * mm, ey + 13.5 * mm, 'Level 0.000', fontName='Helvetica', fontSize=6.5, fillColor=GREY))
    rx, ry, rw, rh = ex + 14 * mm, ey + 4 * mm, 10 * mm, 38 * mm
    d.add(Rect(rx, ry, rw, rh, fillColor=colors.HexColor('#D7E6F5'), strokeColor=NAVY, strokeWidth=1))
    d.add(Line(rx - 3 * mm, ry, rx - 3 * mm, ry + rh, strokeColor=TEAL))
    d.add(String(rx - 13 * mm, ry + rh / 2, 'Height', fontName='Helvetica', fontSize=7, fillColor=TEAL))
    d.add(Line(rx, ry, rx + 26 * mm, ry, strokeColor=colors.red))
    d.add(String(rx + 12 * mm, ry + 1.5 * mm, 'Bottom (m)', fontName='Helvetica', fontSize=7, fillColor=colors.red))
    d.add(String(rx + 12 * mm, ry - 3.5 * mm, 'from level 0.000; negative below ground', fontName='Helvetica', fontSize=6, fillColor=GREY))
    return d


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(GRID)
    canvas.line(18 * mm, 14 * mm, A4[0] - 18 * mm, 14 * mm)
    canvas.setFont('Helvetica', 7.5)
    canvas.setFillColor(GREY)
    canvas.drawString(18 * mm, 9.5 * mm, '3D Model and BOQ - Data Format  |  Version 1.0  |  03 November 2026')
    canvas.drawRightString(A4[0] - 18 * mm, 9.5 * mm, f'Page {doc.page}')
    canvas.restoreState()


s = []
# ---------- cover block
title = Table([[Paragraph('<font size=20 color="white"><b>3D Model and BOQ</b></font>', P)],
               [Paragraph('<font size=13 color="white">Data Format for the PMC Progress Application</font>', P)],
               [Paragraph('<font size=9 color="#D6E2EF">Version 1.0  |  03 November 2026</font>', P)]], colWidths=[W])
title.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), NAVY), ('LEFTPADDING', (0, 0), (-1, -1), 12),
                           ('TOPPADDING', (0, 0), (0, 0), 14), ('BOTTOMPADDING', (0, -1), (0, -1), 12)]))
s += [title, Spacer(1, 8)]

s.append(p('1. Purpose', H1))
s.append(p('For every project, the 3D model and the BOQ are prepared by the design team and uploaded to the PMC Progress '
           'application. After upload, the site team only records work against the model: they select elements, tick the activity '
           'done and its percentage, and the PMC approves it. The same data gives the material required (steel by bar size, '
           'concrete by grade) and the material variation against what was sent to site.'))
s.append(p('This document fixes the format of those files, so that every project can be uploaded directly, without manual rework, '
           'and so that the 3D model and the BOQ always match element by element.'))

s.append(p('2. Files required for each project', H1))
s.append(table(['#', 'File', 'Format', 'Status', 'Contains'], [
    ['1', 'BOQ and Model Data', 'Excel workbook (.xlsx)', '<b>Required</b>', 'Every element with its code, type, level, position, size, concrete grade, BOQ quantities, bar bending schedule (BBS) and wall openings. The application builds the 3D view from this file.'],
    ['2', '3D Model', 'IFC (.ifc), IFC2x3 or IFC4', 'Recommended', 'The detailed 3D model exported from Revit, Tekla, ArchiCAD or Allplan. Each object carries the same Element Code as the Excel file.'],
    ['', '3D Model (alternative)', 'glTF binary (.glb)', 'If IFC is not possible', 'For models from SketchUp, Blender or 3ds Max. Each object name = Element Code.'],
], [0.04, 0.17, 0.19, 0.15, 0.45]))
s.append(Spacer(1, 5))
s += bullets([
    '<b>Not accepted as 3D:</b> DWG / DXF drawings, PDF drawings, images or scans. These are 2D and cannot be used as the model.',
    '<b>File names:</b> <font face="Courier">&lt;Project ID&gt;_&lt;Revision&gt;</font>, for example <font face="Courier">PMC-PH-001_R01.xlsx</font> and <font face="Courier">PMC-PH-001_R01.ifc</font>.',
    '<b>One project, one workbook.</b> A building with several floors stays in one workbook; floors are separated by levels.',
])

s.append(p('3. How the files are linked: the Element Code', H1))
s.append(p('Every element has one <b>Element Code</b>. It is the key that joins the 3D object, its BOQ line, its BBS lines and every '
           'site entry made against it.'))
s += bullets([
    'Unique within the project: no two elements share a code.',
    'The same code in the Excel file and in the 3D file (IFC <i>Tag</i> / <i>Mark</i>, or object <i>Name</i>).',
    'Never changed in a later revision. If C-X1Y1 is revised, it keeps the code C-X1Y1; work already recorded on it carries over.',
])
s.append(CondPageBreak(45 * mm))
s.append(p('Recommended pattern: prefix by type + grid reference.', H2))
s.append(table(['Type', 'Prefix', 'Example', 'Type', 'Prefix', 'Example'], [
    ['Footing', 'F-', 'F-X1Y1', 'Wall', 'W-', 'W-X1Y1-X2Y1'],
    ['Column', 'C-', 'C-X1Y1', 'Lintel', 'L-', 'L-D01'],
    ['Plinth beam', 'PB-', 'PB-X1Y1-X2Y1', 'Chhajja', 'CH-', 'CH-WN01'],
    ['Roof / floor beam', 'RB- / B-', 'RB-X1Y1-X2Y1', 'Door', 'D-', 'D-01'],
    ['Slab', 'SL-', 'SL-ROOF', 'Window', 'WN-', 'WN-01'],
], [0.17, 0.1, 0.23, 0.17, 0.1, 0.23], zebra=True))

s.append(CondPageBreak(70 * mm))
s.append(p('4. Excel workbook (.xlsx) - structure', H1))
s.append(p('The workbook has five sheets. Sheet names and column headings must be exactly as below; the order of columns does not matter. '
           'A ready-made template is supplied with this document: <b>PMC-3D-BOQ-Template.xlsx</b>.'))
s.append(table(['Sheet', 'One row per', 'Required'], [
    ['Project', 'Project detail (Field / Value)', 'Yes'],
    ['Levels', 'Level (Foundation, Ground Floor, First Floor, Roof ...)', 'Yes'],
    ['Elements', 'Element (footing, column, beam, slab, wall, lintel, chhajja, door, window)', 'Yes'],
    ['BBS', 'Bar diameter of an element', 'Yes, for RCC elements'],
    ['Openings', 'Door or window opening in a wall', 'Only where openings exist'],
], [0.18, 0.62, 0.2]))

s.append(p('4.1 Units and coordinates', H2))
s += bullets([
    'All lengths, positions and sizes in <b>metres (m)</b>. Quantities in m<super>3</super>, m<super>2</super>, kg and nos as named in the column heading.',
    '<b>X, Y</b> = centre of the element in plan, measured from one fixed origin (for example grid A-1). The same origin is used in the 3D file.',
    '<b>Bottom</b> = level of the underside of the element, measured from level 0.000 (negative below ground, e.g. footings).',
    '<b>Length</b> = size along X, <b>Width</b> = size along Y, <b>Height</b> = vertical size (slab thickness for slabs).',
    'Each element is described as a rectangular block. Circular or sloping elements are given by their enclosing rectangle; their BOQ quantities stay exact.',
])
s.append(axes_figure())

s.append(CondPageBreak(60 * mm))
s.append(p('4.2 Sheet "Project"', H2))
s.append(table(['Field', 'Example', 'Rule'], [
    ['Project ID', 'PMC-PH-001', 'Required. Fixed for the life of the project.'],
    ['Project Name', 'Pump House', 'Required.'],
    ['Location', 'Nagpur', 'Optional.'],
    ['Client', 'Client name', 'Optional.'],
    ['Model Name', 'Pump House - Structure', 'Required.'],
    ['Revision', 'R01', 'Required. R01 for the first issue; R02, R03 ... for every revised issue.'],
    ['Length Unit', 'm', 'Always m.'],
], [0.2, 0.28, 0.52]))

s.append(CondPageBreak(40 * mm))
s.append(p('4.3 Sheet "Levels"', H2))
s.append(table(['Level ID', 'Level Name', 'Building', 'Elevation (m)'], [
    ['FDN', 'Foundation', 'Pump House', '-1.0'],
    ['GF', 'Ground Floor', 'Pump House', '0.0'],
    ['RF', 'Roof', 'Pump House', '3.2'],
], [0.2, 0.3, 0.3, 0.2]))
s.append(p('Level ID is short and unique (FDN, GF, FF, SF, RF ...). Elevation = finished level of that floor from level 0.000.', SMALL))

s.append(CondPageBreak(70 * mm))
s.append(p('4.4 Sheet "Elements" - the BOQ', H1))
s.append(p('One row per element. Columns marked <b>Required</b> must be filled for every element. A quantity column is filled only when '
           'that work exists in the element; otherwise it is left <b>blank</b> (not 0).'))
s.append(table(['Column', 'Unit', 'Required', 'Description'], [
    ['Element Code', '-', 'Required', 'Unique code (section 3).'],
    ['Type', '-', 'Required', 'One of: footing, column, beam, slab, wall, lintel, chhajja, door, window.'],
    ['Level ID', '-', 'Required', 'Level ID from the Levels sheet.'],
    ['X (m)', 'm', 'Required', 'Plan centre, X.'],
    ['Y (m)', 'm', 'Required', 'Plan centre, Y.'],
    ['Bottom (m)', 'm', 'Required', 'Underside level from 0.000.'],
    ['Length (m)', 'm', 'Required', 'Size along X.'],
    ['Width (m)', 'm', 'Required', 'Size along Y.'],
    ['Height (m)', 'm', 'Required', 'Vertical size.'],
    ['Concrete Grade', '-', 'RCC elements', 'M15, M20, M25, M30 ...'],
    ['Concrete (m3)', 'm<super>3</super>', 'RCC elements', 'Concrete quantity of the element.'],
    ['Steel (kg)', 'kg', 'RCC elements', 'Total reinforcement. Equal to the total of its BBS rows.'],
    ['Shuttering (m2)', 'm<super>2</super>', 'RCC elements', 'Formwork area.'],
    ['Brickwork (m3)', 'm<super>3</super>', 'Walls', 'Masonry volume, openings deducted.'],
    ['Plaster (m2)', 'm<super>2</super>', 'Walls', 'Both faces, openings deducted.'],
    ['Fixing (nos)', 'nos', 'Doors, windows', 'Number of units.'],
    ['Notes', '-', 'Optional', 'Any remark shown with the element.'],
], [0.2, 0.09, 0.16, 0.55], req_rows=range(0, 9)))
s.append(Spacer(1, 6))
s.append(KeepTogether([
    p('Example rows - position and size', H2),
    table(['Element Code', 'Type', 'Level ID', 'X (m)', 'Y (m)', 'Bottom (m)', 'Length (m)', 'Width (m)', 'Height (m)'], [
        ['F-X1Y1', 'footing', 'FDN', '-3.00', '-2.00', '-1.05', '1.20', '1.20', '0.45'],
        ['C-X1Y1', 'column', 'GF', '-3.00', '-2.00', '-0.60', '0.30', '0.30', '3.80'],
        ['PB-X1Y1-X2Y1', 'beam', 'GF', '-1.50', '-2.00', '-0.15', '2.70', '0.23', '0.30'],
        ['SL-ROOF', 'slab', 'RF', '0.00', '0.00', '3.20', '6.30', '4.30', '0.125'],
        ['W-X1Y1-X2Y1', 'wall', 'GF', '-1.50', '-2.00', '0.15', '2.70', '0.23', '2.75'],
    ], [0.18, 0.1, 0.09, 0.09, 0.09, 0.11, 0.115, 0.11, 0.115]),
]))
s.append(Spacer(1, 6))
s.append(KeepTogether([
    p('Example rows - grade and BOQ quantities', H2),
    table(['Element Code', 'Concrete Grade', 'Concrete (m3)', 'Steel (kg)', 'Shuttering (m2)', 'Brickwork (m3)', 'Plaster (m2)'], [
        ['F-X1Y1', 'M20', '0.648', '51.8', '2.16', '', ''],
        ['C-X1Y1', 'M25', '0.342', '61.6', '4.56', '', ''],
        ['PB-X1Y1-X2Y1', 'M25', '0.186', '27.9', '2.24', '', ''],
        ['SL-ROOF', 'M25', '3.386', '338.6', '27.09', '', ''],
        ['W-X1Y1-X2Y1', '', '', '', '', '1.225', '10.65'],
    ], [0.19, 0.13, 0.13, 0.12, 0.15, 0.14, 0.14]),
    p('Blank cells = that work does not exist in the element. The wall has a 1.00 x 2.10 m door opening (see Openings).', SMALL),
]))

s.append(CondPageBreak(70 * mm))
s.append(p('4.5 Sheet "BBS" - bar bending schedule', H1))
s.append(p('One row per bar diameter of an element. The total of an element\'s rows equals its Steel (kg) in the Elements sheet. '
           'This sheet gives the steel required by bar size (8, 10, 12, 16, 20, 25 mm ...).'))
s.append(table(['Element Code', 'Bar Dia (mm)', 'Steel (kg)'], [
    ['C-X1Y1', '8', '12.3'], ['C-X1Y1', '12', '24.6'], ['C-X1Y1', '16', '24.7'], ['F-X1Y1', '10', '20.7'], ['F-X1Y1', '12', '31.1'],
], [0.4, 0.3, 0.3]))
s.append(p('Bar Dia is a whole number from 6 to 40 mm. Several rows of the same element and diameter are added together.', SMALL))

s.append(p('4.6 Sheet "Openings" - doors and windows in walls', H2))
s.append(table(['Wall Code', 'Offset (m)', 'Sill (m)', 'Width (m)', 'Height (m)'], [
    ['W-X1Y1-X2Y1', '0.0', '0.0', '1.00', '2.10'],
    ['W-X2Y2-X3Y2', '0.0', '0.9', '1.20', '1.20'],
], [0.3, 0.175, 0.175, 0.175, 0.175]))
s += bullets([
    '<b>Offset</b> = distance from the centre of the wall to the centre of the opening, along the wall (+ towards +X or +Y).',
    '<b>Sill</b> = height of the opening bottom above the wall bottom (0 for a door).',
    'An opening lies fully inside its wall, and openings in one wall do not overlap.',
])

s.append(p('5. 3D model file (IFC / GLB)', H1))
s += bullets([
    'Export as <b>IFC2x3 or IFC4</b> (Coordination View). Units: metres.',
    'One IFC object per element (IfcFooting, IfcColumn, IfcBeam, IfcSlab, IfcWall, IfcDoor, IfcWindow ...). Do not merge several elements into one object.',
    'Each object\'s <b>Tag</b> (or Mark / Name) = its <b>Element Code</b> in the Excel file.',
    'Same origin and orientation as the X / Y values of the Excel file.',
    'Every element in the Excel file has its object in the 3D file, and the other way round.',
    'For GLB: one mesh per element, the mesh name = Element Code, metres, Y up.',
])

s.append(CondPageBreak(60 * mm))
s.append(p('6. Checks made on upload', H1))
s.append(p('A file with any of these errors is <b>not accepted</b> (nothing is saved) and the message names the sheet, row and element:'))
s += bullets([
    'A required sheet or column is missing; an Element Code is blank or repeated.',
    'Type is not one of the allowed types; a Level ID is not in the Levels sheet.',
    'A size is zero or negative; a value is not a number; a quantity is negative.',
    'A quantity is given for work that does not belong to that type (e.g. concrete in a brick wall).',
    'A BBS or Openings row names an element that is not in the Elements sheet; a bar diameter outside 6-40 mm.',
    'An opening does not fit inside its wall, or two openings overlap.',
])
s.append(p('The file is accepted with a <b>warning</b> when:'))
s += bullets([
    'The BBS total of an element differs from its Steel (kg) by more than 1% (0.5 kg).',
    'Concrete (m3) differs from Length x Width x Height by more than 15% (BOQ and 3D do not match).',
    'Brickwork of a wall is more than 10% above its size.',
])

s.append(KeepTogether([
    p('7. Revisions', H1),
    p('A revised model is sent as a new file with the same Project ID and the next Revision (R02, R03 ...). The new revision becomes the '
      'active model; the earlier one is kept for record. Work recorded on an element carries over as long as its Element Code is unchanged.'),
]))

s.append(KeepTogether([
    p('8. Checklist before sending', H1),
    table(['', 'Check'], [
        ['[ ]', 'File names follow <font face="Courier">&lt;Project ID&gt;_&lt;Revision&gt;</font>.'],
        ['[ ]', 'All five sheets present with the exact headings of the template.'],
        ['[ ]', 'Every element has a unique Element Code, a Type and a Level ID.'],
        ['[ ]', 'Positions and sizes in metres, from one origin; same origin as the 3D file.'],
        ['[ ]', 'Concrete grade and BOQ quantities filled; blank where the work does not apply.'],
        ['[ ]', 'BBS totals equal Steel (kg) of each element.'],
        ['[ ]', 'Wall openings listed; doors and windows also listed as elements.'],
        ['[ ]', '3D file objects carry the same Element Codes.'],
        ['[ ]', 'Revision number increased for a revised issue.'],
    ], [0.06, 0.94]),
]))

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=20 * mm,
                        title='3D Model and BOQ - Data Format', author='PMC Progress', subject='Data format for 3D model and BOQ upload')
doc.build(s, onFirstPage=footer, onLaterPages=footer)
print('ok', OUT)
