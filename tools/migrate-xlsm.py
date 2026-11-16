#!/usr/bin/env python3
"""
Convierte CONTROL GYMBRAS.xlsm en archivos CSV listos para importar al Google Sheet.

    python3 tools/migrate-xlsm.py "CONTROL GYMBRAS.xlsm" [carpeta_salida]

- SOLO LEE el xlsm (no lo modifica).
- Escribe en `migration/` (por defecto), carpeta ignorada por git: contiene datos
  personales (DPI, teléfonos, fechas de nacimiento). No la subas a ningún repositorio.
- Genera: Miembros.csv, Pagos.csv, Medidas.csv, Evaluaciones.csv, rechazados.csv
  y reporte.json (conteos y totales para comparar con el Google Sheet).

Reglas (ver el plan del proyecto):
- La clave interna es MemberID (GB-0001…); el DPI queda como un campo más.
- Teléfonos: 8 dígitos locales (el código de país se agrega al armar el enlace).
- Todos los miembros se importan como "Activo".
- Cada miembro recibe un TokenQR aleatorio (el QR nunca contiene el DPI) y cada pago
  un ComprobanteToken para su boleta.
"""
import csv
import datetime as dt
import json
import re
import secrets
import sys
from collections import Counter, OrderedDict
from pathlib import Path

try:
    import openpyxl
except ImportError:  # pragma: no cover
    sys.exit("Falta openpyxl: pip install openpyxl")

EXERCISES = [f"N{level}{n}" for level in range(4) for n in range(1, 8)]
MEMBER_HEADERS = ["MemberID", "DPI", "Nombres", "Apellidos", "FechaNacimiento", "Telefono", "Correo",
                  "Genero", "Mensualidad", "DiaPago", "Estado", "TokenQR", "FechaRegistro", "Notas"]
PAYMENT_HEADERS = ["PagoID", "MemberID", "Fecha", "Monto", "Nota", "ComprobanteToken"]
MEASURE_HEADERS = ["MedidaID", "MemberID", "Fecha", "Cuello", "Pecho", "BrazoDer", "BrazoIzq", "Cintura",
                   "Cadera", "PiernaDer", "PiernaIzq", "PesoLb"]
EVAL_HEADERS = ["EvalID", "MemberID", "Fecha"] + EXERCISES
# Orden de columnas en USER_MEASUREMENTS: ID, Date, Neck, Chest, Right arm, Left arm, Waist, Hip, Right leg, Left leg, Weight
GENDER = {"male": "Masculino", "female": "Femenino"}


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def to_date(value):
    """Devuelve (date|None, error|None). Acepta datetime/date o 'dd/mm/yyyy'/'yyyy-mm-dd'."""
    if value is None or value == "":
        return None, None
    if isinstance(value, dt.datetime):
        return value.date(), None
    if isinstance(value, dt.date):
        return value, None
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(text, fmt).date(), None
        except ValueError:
            pass
    return None, f"fecha no válida: {text!r}"


def to_number(value):
    """Devuelve (número|None, error|None)."""
    if value is None or value == "":
        return None, None
    if isinstance(value, bool):
        return None, f"valor no numérico: {value!r}"
    if isinstance(value, (int, float)):
        return (int(value) if float(value).is_integer() else float(value)), None
    text = str(value).strip().replace(",", ".")
    try:
        number = float(text)
        return (int(number) if number.is_integer() else number), None
    except ValueError:
        return None, f"valor no numérico: {value!r}"


def digits(value):
    return re.sub(r"\D", "", str(value if value is not None else ""))


def read_rows(ws):
    rows = list(ws.iter_rows(min_row=2, values_only=True))
    return [r for r in rows if any(v is not None and v != "" for v in r)]


def iso(d):
    return d.isoformat() if d else ""


def write_csv(path, headers, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(headers)
        writer.writerows(rows)


def migrate(xlsm_path, out_dir):
    wb = openpyxl.load_workbook(xlsm_path, data_only=True, keep_vba=False)
    for name in ("USERS", "USER_PAYMENTS", "USER_MEASUREMENTS", "USER_TESTS"):
        if name not in wb.sheetnames:
            sys.exit(f"El archivo no tiene la hoja {name}; ¿es el CONTROL GYMBRAS correcto?")

    issues = []  # (hoja, referencia, problema) — la referencia nunca incluye nombres
    rejected = []

    # ---------- Miembros ----------
    user_rows = read_rows(wb["USERS"])
    payments_raw = read_rows(wb["USER_PAYMENTS"])
    last_payment_day = {}
    for r in payments_raw:
        d, _ = to_date(r[1])
        key = digits(r[0])
        if d and (key not in last_payment_day or d > last_payment_day[key][0]):
            last_payment_day[key] = (d, d.day)

    members = []
    by_dpi = {}
    seen_tokens = set()
    for index, r in enumerate(user_rows, start=1):
        dpi = digits(r[0])
        member_id = f"GB-{index:04d}"
        ref = f"USERS fila {index + 1} ({member_id})"
        if len(dpi) != 13:
            issues.append(("USERS", ref, f"DPI con {len(dpi)} dígitos (se esperaban 13)"))
        if dpi in by_dpi:
            issues.append(("USERS", ref, "DPI duplicado: se omite"))
            rejected.append(["USERS", ref, "DPI duplicado", json.dumps([str(v) for v in r], ensure_ascii=False)])
            continue

        birth, err = to_date(r[3])
        if err:
            issues.append(("USERS", ref, "FechaNacimiento " + err))
        phone = digits(r[5])
        if len(phone) != 8:
            issues.append(("USERS", ref, f"Teléfono con {len(phone)} dígitos (se esperaban 8)"))
        email = clean_text(r[6]).lower()
        if email and not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            issues.append(("USERS", ref, "Correo no válido: se deja vacío"))
            email = ""
        gender = GENDER.get(clean_text(r[7]).lower(), "")
        if not gender:
            issues.append(("USERS", ref, f"Género no reconocido: {clean_text(r[7])!r}"))
        fee, err = to_number(r[8])
        if err or fee is None:
            issues.append(("USERS", ref, "Mensualidad " + (err or "vacía")))
        pay_date, err = to_date(r[9])
        if err:
            issues.append(("USERS", ref, "Fecha de pago " + err))

        pay_day = pay_date.day if pay_date else ""
        if not pay_date and dpi in last_payment_day:
            pay_day = last_payment_day[dpi][1]
            issues.append(("USERS", ref, f"Sin fecha de pago: DiaPago {pay_day} tomado de su último pago"))
        elif not pay_date:
            issues.append(("USERS", ref, "Sin fecha de pago ni pagos: DiaPago vacío (no recibirá recordatorios)"))

        token = secrets.token_hex(12)
        while token in seen_tokens:
            token = secrets.token_hex(12)
        seen_tokens.add(token)

        by_dpi[dpi] = member_id
        members.append([member_id, dpi, clean_text(r[1]), clean_text(r[2]), iso(birth), phone, email, gender,
                        fee if fee is not None else "", pay_day, "Activo", token, iso(pay_date), ""])

    member_ids = set(by_dpi.values())

    # ---------- Pagos ----------
    payments = []
    for index, r in enumerate(payments_raw, start=1):
        ref = f"USER_PAYMENTS fila {index + 1}"
        member = by_dpi.get(digits(r[0]))
        date, err = to_date(r[1])
        amount, err2 = to_number(r[2])
        if not member:
            rejected.append(["USER_PAYMENTS", ref, "DPI no existe en USERS", json.dumps([str(v) for v in r], ensure_ascii=False)])
            issues.append(("USER_PAYMENTS", ref, "DPI sin miembro: se rechaza"))
            continue
        if err or err2 or not date or amount is None:
            rejected.append(["USER_PAYMENTS", ref, err or err2 or "datos vacíos", json.dumps([str(v) for v in r], ensure_ascii=False)])
            issues.append(("USER_PAYMENTS", ref, "Fecha o monto no válido: se rechaza"))
            continue
        payments.append((date, index, member, amount))
    payments.sort(key=lambda p: (p[0], p[1]))
    payment_rows = [[f"PG-{i:05d}", m, iso(d), amount, "", secrets.token_hex(12)]
                    for i, (d, _, m, amount) in enumerate(payments, start=1)]

    # ---------- Medidas ----------
    measure_rows_raw = read_rows(wb["USER_MEASUREMENTS"])
    measures = []
    for index, r in enumerate(measure_rows_raw, start=1):
        ref = f"USER_MEASUREMENTS fila {index + 1}"
        member = by_dpi.get(digits(r[0]))
        date, err = to_date(r[1])
        if not member:
            rejected.append(["USER_MEASUREMENTS", ref, "DPI no existe en USERS", json.dumps([str(v) for v in r], ensure_ascii=False)])
            issues.append(("USER_MEASUREMENTS", ref, "DPI sin miembro: se rechaza"))
            continue
        if err or not date:
            rejected.append(["USER_MEASUREMENTS", ref, err or "sin fecha", json.dumps([str(v) for v in r], ensure_ascii=False)])
            issues.append(("USER_MEASUREMENTS", ref, "Fecha no válida: se rechaza"))
            continue
        values = []
        for offset, label in enumerate(MEASURE_HEADERS[3:], start=2):
            number, err = to_number(r[offset] if offset < len(r) else None)
            if err:
                issues.append(("USER_MEASUREMENTS", ref, f"{label}: {err}; se deja vacío"))
                number = None
            values.append("" if number is None else number)
        measures.append((date, index, member, values))
    measures.sort(key=lambda m: (m[0], m[1]))
    measure_rows = [[f"MD-{i:05d}", m, iso(d)] + vals for i, (d, _, m, vals) in enumerate(measures, start=1)]

    # ---------- Evaluaciones ----------
    test_ws = wb["USER_TESTS"]
    test_header = [clean_text(c.value) for c in test_ws[1]]
    for code in EXERCISES:
        if code not in test_header:
            sys.exit(f"USER_TESTS no tiene la columna {code}")
    col = {name: i for i, name in enumerate(test_header)}
    evals = []
    for index, r in enumerate(read_rows(test_ws), start=1):
        ref = f"USER_TESTS fila {index + 1}"
        member = by_dpi.get(digits(r[col["ID"]]))
        date, err = to_date(r[col["DATE"]])
        if not member:
            rejected.append(["USER_TESTS", ref, "DPI no existe en USERS", json.dumps([str(v) for v in r], ensure_ascii=False)])
            issues.append(("USER_TESTS", ref, "DPI sin miembro: se rechaza"))
            continue
        if err or not date:
            rejected.append(["USER_TESTS", ref, err or "sin fecha", json.dumps([str(v) for v in r], ensure_ascii=False)])
            issues.append(("USER_TESTS", ref, "Fecha no válida: se rechaza"))
            continue
        values = []
        for code in EXERCISES:
            number, err = to_number(r[col[code]])
            if err:
                issues.append(("USER_TESTS", ref, f"{code}: {err}; se deja vacío"))
                number = None
            values.append("" if number is None else number)
        evals.append((date, index, member, values))
    evals.sort(key=lambda e: (e[0], e[1]))
    eval_rows = [[f"EV-{i:05d}", m, iso(d)] + vals for i, (d, _, m, vals) in enumerate(evals, start=1)]

    # ---------- Escritura ----------
    out_dir.mkdir(parents=True, exist_ok=True)
    write_csv(out_dir / "Miembros.csv", MEMBER_HEADERS, members)
    write_csv(out_dir / "Pagos.csv", PAYMENT_HEADERS, payment_rows)
    write_csv(out_dir / "Medidas.csv", MEASURE_HEADERS, measure_rows)
    write_csv(out_dir / "Evaluaciones.csv", EVAL_HEADERS, eval_rows)
    write_csv(out_dir / "rechazados.csv", ["Hoja", "Referencia", "Motivo", "Fila original"], rejected)

    last_pay = {}
    for date, _, m, _amount in payments:
        last_pay[m] = max(last_pay.get(m, date), date)
    latest_weight = {}
    for date, _, m, vals in measures:
        weight = vals[-1]
        if weight != "":
            latest_weight[m] = (date, weight)

    report = OrderedDict([
        ("generado", dt.datetime.now().isoformat(timespec="seconds")),
        ("origen", Path(xlsm_path).name),
        ("miembros", len(members)),
        ("pagos", len(payment_rows)),
        ("pagos_total_monto", sum(p[3] for p in payments)),
        ("medidas", len(measure_rows)),
        ("evaluaciones", len(eval_rows)),
        ("rechazados", dict(Counter(r[0] for r in rejected))),
        ("miembros_sin_pagos", len(member_ids - {p[2] for p in payments})),
        ("miembros_con_correo", sum(1 for m in members if m[6])),
        ("miembros_sin_dia_pago", sum(1 for m in members if m[9] == "")),
        ("estado", dict(Counter(m[10] for m in members))),
        ("avisos", len(issues)),
        ("ultimo_pago_mas_reciente", max((iso(d) for d in last_pay.values()), default="")),
        ("peso_mas_reciente_total_lb", sum(w for _d, w in latest_weight.values())),
    ])
    (out_dir / "reporte.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report, issues


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    xlsm = Path(argv[1])
    out_dir = Path(argv[2]) if len(argv) > 2 else Path("migration")
    if not xlsm.exists():
        sys.exit(f"No existe {xlsm}")
    report, issues = migrate(xlsm, out_dir)
    print(f"\nListo. Archivos en {out_dir}/\n")
    for key, value in report.items():
        print(f"  {key:30} {value}")
    if issues:
        print(f"\nAvisos ({len(issues)}):")
        shown = Counter(i[2].split(':')[0] for i in issues)
        for text, n in shown.most_common():
            print(f"  {n:3} × {text}")
        print("\n  Detalle por fila en consola con --detalle")
        if "--detalle" in argv:
            for hoja, ref, problema in issues:
                print(f"  [{hoja}] {ref}: {problema}")


if __name__ == "__main__":
    main(sys.argv)
