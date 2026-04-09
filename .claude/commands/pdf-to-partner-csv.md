# /pdf-to-partner-csv — Sync Partnership Interest List PDF to CSV

Reads the FY27 Lighthouse Grant Partnership Interest List PDF, extracts all organization entries, and writes them to `interest-partner.csv` in the repo root. If the CSV already exists, only new organizations (by name, case-insensitive) are appended — existing rows are never modified or removed.

## How to use

```
/pdf-to-partner-csv
/pdf-to-partner-csv "/path/to/custom.pdf"
```

No arguments needed for the standard weekly PDF.

---

$ARGUMENTS

---

## Instructions for Claude

Work through each step in order. Do not ask for confirmation unless you hit a blocker you cannot resolve.

### Step 1 — Resolve paths

If `$ARGUMENTS` contains a file path, use it as `PDF_PATH`. Otherwise use the default:

```
PDF_PATH = <repo-root>/docs/FY27-Lighthouse-Grant-Partnership-Interest-List .pdf
CSV_PATH = <repo-root>/interest-partner.csv
```

The PDF filename has a trailing space before `.pdf` — use the exact filename as-is.

Determine `<repo-root>` by running:
```bash
git rev-parse --show-toplevel
```

### Step 2 — Read the PDF

Use the Read tool on `PDF_PATH`. The file is a multi-page two-column list of organization bullet entries.

### Step 3 — Extract all entries

Parse every organization entry from the PDF into a list of records. Each bullet entry follows this structure:

- **Organization name** (bold)
- One or more contact blocks, separated by the word "and" on its own line when there are multiple
- Each contact block has: name, job title (or "No Job Title"), email address
- Street address block (or "No Address Provided" / "No Organization Address" / a literal like "Remote", "DMV")
- Website URL (or "No Website Provided" / "No Organization Website Provided")

For each record extract these fields:

| Field | Rule |
|---|---|
| `organization` | The bold bullet text, exactly as printed |
| `contact_names` | All contact names in encounter order, joined with `"; "` |
| `titles` | Titles in same order as contacts, joined with `"; "`; use `""` for "No Job Title" |
| `emails` | Emails in same order as contacts, joined with `"; "` |
| `address` | Full address linearized to one string (join lines with a space); `""` if none given; preserve literals like "DMV", "Remote" |
| `website` | URL as printed; `""` if none given |

Address normalization: collapse the multi-line block to a single line joined by spaces. Do not strip content, but do not add extra separators.

Website note: if an entry lists two URLs (e.g. MOCO STEM For Kids), use only the first one.

### Step 4 — Check whether the CSV exists

```bash
test -f "$CSV_PATH" && echo "exists" || echo "missing"
```

### Step 5 — Filter to new-only rows (if CSV exists)

If the CSV exists, use the Read tool to read it. Extract the value in the `organization` column from every data row (skip the header row). Build a set of existing org names — strip whitespace and lowercase each one. Call this `EXISTING_ORGS`.

For each extracted record, compute `key = record.organization.strip().lower()`. If `key` is in `EXISTING_ORGS`, skip the record. Collect the remaining records as `NEW_ROWS`.

If `NEW_ROWS` is empty, report:
```
All organizations already present in interest-partner.csv — nothing to add.
```
and stop.

If the CSV does not exist, treat all extracted records as `NEW_ROWS`.

### Step 6 — Write the output

CSV columns (in order):
```
organization,contact_names,titles,emails,address,website
```

CSV formatting rules:
- Wrap any field in double quotes if it contains a comma
- Escape a literal double quote inside a field as `""`
- Semicolons do not need quoting unless the field also contains a comma
- Empty fields are written as empty (two consecutive commas or trailing comma)

**If the CSV does not exist:** use the Write tool to create the full file — one header row, then one row per extracted record (all records, not just `NEW_ROWS`).

**If the CSV exists:** append `NEW_ROWS` to the end of the file. First check whether the file ends with a newline:
```bash
tail -c1 "$CSV_PATH" | xxd | grep -q "0a" && echo "has_newline" || echo "no_newline"
```
If there is no trailing newline, prepend a newline before the first appended row. Use the Edit tool to append to the file.

### Step 7 — Report results

Print a summary:
```
Done.
  PDF organizations: <total extracted>
  Already in CSV (skipped): <count>
  New rows added: <count>
  CSV path: <CSV_PATH>
```
