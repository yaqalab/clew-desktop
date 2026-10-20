# Clew analysis server

Runs analyses Clew does not do in the browser (regressions, exact and rank tests, reliability) in
**your own copy of R**, on your own computer. It is a translator: Clew sends one neutral command
with the data ("linear regression, Dependent q1, Independent q2"), this server writes and runs the
R code for it, and sends one result back, which Clew shows, saves and exports like its own tables.
Every result carries the exact R script that ran, so the numbers can be checked outside Clew.

Clew never sends code. It can only choose one of the commands below, or one of your own scripts
when you turn a folder of them on.

## Start it

You need [R](https://cran.r-project.org) (4.0 or later). Nothing else: the commands use base R and
`MASS`, which comes with R.

**On Windows**, tick **Analysis** in the Clew audio server's installer: the engine is packed with
Python inside it (`build_exe.ps1`, about 18 MB), and the settings window's **Analysis** tab starts
it, shows which R it found, and keeps its key (encrypted for your Windows account). Elsewhere:

```
clew-analysis-server            # installed with pipx as part of clew-tools
python -m clew_analysis         # or from this folder
```

The first start makes a key and prints it. In Clew, open **Analysis**, then **Start › On this
computer › Connect**, and paste the address (`http://127.0.0.1:47823`) and the key.
`--show-key` prints the key again; it is kept in `key.txt` in the settings folder
(`%APPDATA%\clew-analysis-server` on Windows, `~/.config/clew-analysis-server` elsewhere),
readable by you only.

| Option | Does |
|---|---|
| `--port 47823` | The port (loopback only: nothing outside this computer can reach it) |
| `--backend r` | The program that runs the commands. R now; Conda Python, PSPP and SPSS later |
| `--rscript PATH` | Rscript, when it is not found on `PATH`, in the registry or in Program Files |
| `--scripts DIR` | A folder of your own R scripts (below) |
| `--timeout 120` | Seconds a run may take before it is stopped |
| `--allow-origin URL` | Another address Clew is served from (`https://clew.alefa.net` is allowed) |
| `--check` | Lists what it found and the commands, then stops |
| `--key-stdin` | Reads the key from the first line of standard input (how the Windows tray starts it) |

## Commands

| Command | Dependent | Independent |
|---|---|---|
| `regression.linear` | one number | one or more |
| `regression.logistic` | one category with two values | one or more |
| `regression.ordinal` | one category, taken in the form's order | one or more |
| `test.fisher` | one category | one category |
| `test.ranks` (Mann–Whitney, Kruskal–Wallis) | a number or ordered category | one category |
| `reliability.alpha` | two or more items | none |

Group by runs any of them once per group. Each command is a folder in `clew_analysis/commands`:
`command.json` (what it needs) and `r.R` (the adapter, which defines `analyse(d, spec)`).
`clew.R` is the shared part: it reads the command and the data from standard input, builds the
data frame with each column's level and order, runs the adapter, and prints the result.

## Your own scripts

Put R files in a folder and start with `--scripts DIR`. Each defines `analyse(d, spec)` and returns
`list(tables = list(clew_table(title, head, rows)), notes = "...")`. `d` is the data, one column per
variable sent, numbers as numbers and categories as factors; `spec$dependent`, `spec$independent`
and `spec$labels` say what was chosen. Optional header lines:

```r
#' title: Mean of each column
#' dependent: 1-5
#' independent: 0
```

## Privacy

Only the columns on Clew's board and the rows its filters keep are sent, to this program on your
computer, which hands them to R on its standard input: nothing is written to disk. Logs carry the
method, path and status of each request, never its content. Same guards as the audio server:
loopback only, the `Host` and `Origin` checked, the key compared in constant time, `no-store`.

## Tests

```
python -m unittest discover -s tests -v
```

They start a real server and, when R is installed, run every command in real R. The numbers are
checked against values worked out in Python and a textbook table, not against R itself.
