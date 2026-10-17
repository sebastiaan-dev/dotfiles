"""Validate file-based chart data and render figures locally, without executing input."""

import csv
import io
import json
import math
import os
from pathlib import Path
import sys

os.environ["MPLBACKEND"] = "Agg"
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

COLORS = ["#8ba4b0", "#8992a7", "#98BB6C", "#DCA561", "#C34043", "#8ea4a2"]
BG, FG, GRID = "#14171d", "#C5C9C7", "#393B44"
MAX_POINTS = 200_000
KINDS = {"line", "scatter", "bar", "histogram", "box"}


def text(value, field, limit=160):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"{field} must be text of at most {limit} characters.")
    if any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in value):
        raise ValueError(f"{field} cannot contain terminal control characters.")
    return value


def numbers(value, field, nullable=False):
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_POINTS:
        raise ValueError(f"{field} must contain 1–{MAX_POINTS:,} values.")
    for item in value:
        if nullable and item is None:
            continue
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item):
            raise ValueError(f"{field} must contain finite numbers.")
    return value


def validate(data):
    if not isinstance(data, dict) or data.get("kind") not in KINDS:
        raise ValueError("Chart kind must be line, scatter, bar, histogram, or box.")
    allowed = {"kind", "title", "xLabel", "yLabel", "xScale", "yScale", "series", "labels", "bins", "notes"}
    if data.keys() - allowed:
        raise ValueError("Unknown chart fields: " + ", ".join(sorted(data.keys() - allowed)))
    for field in ("title", "xLabel", "yLabel"):
        data[field] = text(data.get(field, ""), field)
    for field in ("xScale", "yScale"):
        data[field] = data.get(field, "linear")
        if data[field] not in {"linear", "log"}:
            raise ValueError(f"{field} must be linear or log.")
    if not isinstance(data.get("notes", []), list):
        raise ValueError("notes must be an array of text.")
    data["notes"] = [text(note, "note", 512) for note in data.get("notes", [])]
    if len(data["notes"]) > 128:
        raise ValueError("A chart can contain at most 128 notes.")
    series = data.get("series")
    if not isinstance(series, list) or not 1 <= len(series) <= 32:
        raise ValueError("A chart must contain 1–32 series.")
    count = 0
    sample_plot = data["kind"] in {"histogram", "box"}
    for index, item in enumerate(series):
        if not isinstance(item, dict) or item.keys() - {"name", "x", "y", "values", "yError"}:
            raise ValueError("Each series must contain name and numeric data only.")
        item["name"] = text(item.get("name", f"Series {index + 1}"), "series name", 100)
        key = "values" if sample_plot else "y"
        numbers(item.get(key), key)
        count += len(item[key])
        if sample_plot and (item.keys() & {"x", "y", "yError"}):
            raise ValueError("Histogram/box series use values, not x/y/yError.")
        if not sample_plot:
            if "values" in item:
                raise ValueError("Line/scatter/bar series use y, not values.")
            if data["kind"] == "bar" and "x" in item:
                raise ValueError("Bar charts use labels, not x coordinates.")
            if data["kind"] in {"line", "scatter"}:
                item["x"] = numbers(item.get("x", list(range(1, len(item["y"]) + 1))), "x")
                if len(item["x"]) != len(item["y"]):
                    raise ValueError("Each x array must match its y array.")
            if "yError" in item:
                errors = numbers(item["yError"], "yError", nullable=True)
                if len(errors) != len(item["y"]) or any(e is not None and e < 0 for e in errors):
                    raise ValueError("yError must match y and contain nonnegative values or null.")
        if data["xScale"] == "log":
            axis = item["values"] if sample_plot else item.get("x", [])
            if any(v <= 0 for v in axis):
                raise ValueError("Logarithmic x axes require positive values.")
        if data["yScale"] == "log" and not sample_plot and any(v <= 0 for v in item["y"]):
            raise ValueError("Logarithmic y axes require positive values.")
    if count > MAX_POINTS:
        raise ValueError(f"A chart may contain at most {MAX_POINTS:,} total points.")
    if data["kind"] == "bar":
        size = len(series[0]["y"])
        labels = data.get("labels", [str(i + 1) for i in range(size)])
        if not isinstance(labels, list) or len(labels) != size or any(len(s["y"]) != size for s in series):
            raise ValueError("Bar labels and every series must have equal lengths.")
        if size > 128:
            raise ValueError("Bar charts support at most 128 categories.")
        data["labels"] = [text(label, "bar label", 100) for label in labels]
        if data["xScale"] != "linear":
            raise ValueError("A bar chart's categorical x axis must be linear.")
    elif "labels" in data:
        raise ValueError("Only bar charts accept labels.")
    if data["kind"] == "box" and data["yScale"] != "linear":
        raise ValueError("Horizontal box plots use xScale for their numeric axis.")
    bins = data.get("bins", 20)
    if isinstance(bins, bool) or not isinstance(bins, int) or not 2 <= bins <= 100:
        raise ValueError("bins must be an integer between 2 and 100.")
    data["bins"] = bins
    return data, count


def read_input(request):
    source = Path(request["input"])
    options = request.get("options", {})
    if source.suffix.lower() not in {".csv", ".tsv"}:
        if options:
            raise ValueError("Chart options are for CSV/TSV inputs; JSON files contain their own spec.")
        return json.loads(source.read_text())
    delimiter = "\t" if source.suffix.lower() == ".tsv" else ","
    reader = csv.DictReader(io.StringIO(source.read_text(encoding="utf-8-sig")), delimiter=delimiter)
    if not reader.fieldnames or any(not name for name in reader.fieldnames) or len(set(reader.fieldnames)) != len(reader.fieldnames):
        raise ValueError("CSV/TSV needs distinct, nonempty column headers.")
    rows = list(reader)
    if any(None in row or any(value is None for value in row.values()) for row in rows):
        raise ValueError("CSV/TSV rows must have the same number of fields as their header.")
    if not rows or len(rows) > MAX_POINTS:
        raise ValueError("CSV/TSV must contain a header and 1–200,000 rows.")
    columns = options.pop("yColumns", None)
    x_column = options.pop("xColumn", None)
    if not columns or not isinstance(columns, list) or len(set(columns)) != len(columns):
        raise ValueError("CSV/TSV inputs need distinct yColumns; xColumn is optional.")
    kind = options.get("kind", "line")
    options["kind"] = kind
    sample_plot = kind in {"histogram", "box"}
    if sample_plot and x_column:
        raise ValueError("Histogram/box CSV inputs need only yColumns.")
    def column(name):
        try:
            return [float(row[name]) for row in rows]
        except (KeyError, ValueError, TypeError) as error:
            raise ValueError(f"Column {name!r} is missing or contains empty/nonnumeric values.") from error
    series = []
    for name in columns:
        item = {"name": name, "values" if sample_plot else "y": column(name)}
        if x_column and kind in {"line", "scatter"}:
            item["x"] = column(x_column)
        series.append(item)
    options["series"] = series
    if kind == "bar" and x_column:
        if any(x_column not in row or row[x_column] is None for row in rows):
            raise ValueError("Bar label column is missing.")
        options["labels"] = [row[x_column] for row in rows]
    return options


def terminal_parts(spec):
    """Explicit transformations, equal-length groups, and no padding with invented zeros."""
    kind, series = spec["kind"], spec["series"]
    extra = []
    x_label, y_label = spec["xLabel"], spec["yLabel"]
    def transform(values, scale):
        return [math.log10(v) for v in values] if scale == "log" else values
    if spec["xScale"] == "log":
        x_label = "log10 " + (x_label or "x")
    if spec["yScale"] == "log":
        y_label = "log10 " + (y_label or "y")
    if any("yError" in item for item in series):
        extra.append("Error bars are shown in PNG/SVG; the terminal preview shows central values.")
    def part(command, rows, title, flags=None, xlabel=x_label, ylabel=y_label):
        stream = io.StringIO()
        writer = csv.writer(stream, delimiter="\t", lineterminator="\n")
        writer.writerows(rows)
        return {"command": command, "data": stream.getvalue(), "title": title[:100],
                "flags": flags or [], "xLabel": xlabel, "yLabel": ylabel}
    if kind in {"line", "scatter"}:
        groups = [series] if len({len(s["y"]) for s in series}) == 1 else [[s] for s in series]
        if len(groups) > 1:
            extra.append("Unequal-length series have separate previews; PNG/SVG combines them.")
        parts = []
        for group in groups:
            columns, names = [], []
            for s in group:
                columns.extend([transform(s["x"], spec["xScale"]), transform(s["y"], spec["yScale"])])
                names.extend([s["name"][:24], s["name"][:24]])
            rows = [names, *zip(*columns)]
            title = spec["title"] if len(groups) == 1 else s["name"]
            parts.append(part("lines" if kind == "line" else "scatter", rows, title, ["--fmt", "xyxy", "--headers"]))
        return parts, extra
    if kind == "bar":
        return [part("bar", list(zip([label[:24] for label in spec["labels"]], transform(s["y"], spec["yScale"]))),
                     s["name"], xlabel=y_label, ylabel="") for s in series], extra
    if kind == "box":
        if len(series) == 1:
            rows = [[series[0]["name"][:24]], *[[v] for v in transform(series[0]["values"], spec["xScale"])]]
            flags = ["--headers"]
        else:
            rows = [[s["name"][:24], *transform(s["values"], spec["xScale"])] for s in series]
            flags = ["--transpose", "--headers"]
        extra.append("Box: Q1/median/Q3; whiskers span the measured minimum and maximum.")
        return [part("box", rows, spec["title"], flags, ylabel="")], extra
    values = np.concatenate([s["values"] for s in series])
    edges = np.geomspace(values.min(), values.max(), spec["bins"] + 1) if spec["xScale"] == "log" and values.min() != values.max() else np.histogram_bin_edges(values, bins=spec["bins"])
    labels = [f"[{a:.5g}, {b:.5g}{']' if i == len(edges) - 2 else ')'}" for i, (a, b) in enumerate(zip(edges[:-1], edges[1:]))]
    parts = []
    for s in series:
        counts, _ = np.histogram(s["values"], bins=edges)
        parts.append(part("bar", list(zip(labels, counts.tolist())), s["name"],
                          xlabel="Count", ylabel=spec["xLabel"] or "Value"))
    extra.append("Histograms use identical bin edges in every series and export.")
    return parts, extra


def render(spec, index, directory):
    plt.rcParams.update({
        "figure.facecolor": BG, "axes.facecolor": BG, "text.color": FG,
        "axes.labelcolor": FG, "axes.edgecolor": GRID, "xtick.color": FG, "ytick.color": FG,
        "grid.color": GRID, "font.family": "DejaVu Sans", "svg.fonttype": "none",
        "axes.formatter.use_mathtext": False, "text.usetex": False,
    })
    height = max(5.2, min(16, len(spec.get("labels", [])) * .3 + 2)) if spec["kind"] == "bar" else 5.2
    fig, ax = plt.subplots(figsize=(10, height), layout="constrained")
    title = spec["title"]
    if spec["kind"] == "box":
        title += "\nBox: Q1/median/Q3; whiskers: min/max"
    ax.set_title(title, loc="left", pad=15)
    ax.grid(alpha=.65)
    ax.set_axisbelow(True)
    # Scaling installs default tick formatters; do it before categorical labels.
    ax.set_xscale(spec["xScale"])
    ax.set_yscale(spec["yScale"])
    kind, series = spec["kind"], spec["series"]
    for i, s in enumerate(series):
        color = COLORS[i % len(COLORS)]
        if kind in {"line", "scatter"}:
            errors = [float("nan") if e is None else e for e in s.get("yError", [])]
            ax.errorbar(s["x"], s["y"], yerr=errors or None, label=s["name"], color=color,
                        fmt="-o" if kind == "line" else "o", markersize=3, capsize=3)
        elif kind == "bar":
            positions = np.arange(len(s["y"])) + (i - (len(series) - 1) / 2) * .8 / len(series)
            errors = [float("nan") if e is None else e for e in s.get("yError", [])]
            ax.bar(positions, s["y"], width=.8 / len(series), label=s["name"], color=color,
                   yerr=errors or None, capsize=4, error_kw={"ecolor": FG})
        elif kind == "histogram":
            values = np.concatenate([item["values"] for item in series])
            edges = np.geomspace(values.min(), values.max(), spec["bins"] + 1) if spec["xScale"] == "log" and values.min() != values.max() else np.histogram_bin_edges(values, bins=spec["bins"])
            ax.hist(s["values"], bins=edges, histtype="step", linewidth=1.8, color=color, label=s["name"])
    if kind == "box":
        artists = ax.boxplot([s["values"] for s in series], orientation="horizontal",
                             tick_labels=[s["name"] for s in series], patch_artist=True,
                             whis=(0, 100),
                             medianprops={"color": FG}, whiskerprops={"color": FG},
                             capprops={"color": FG}, flierprops={"markeredgecolor": FG, "markersize": 3})
        for box, color in zip(artists["boxes"], COLORS * 6):
            box.set_facecolor(color)
    elif len(series) > 1 or kind in {"line", "scatter"} or any("yError" in item for item in series):
        ax.legend(facecolor=BG, edgecolor=GRID, labelcolor=FG)
    if kind == "bar":
        ax.set_xticks(range(len(spec["labels"])), spec["labels"], rotation=30, ha="right")
    ax.set_xlabel(spec["xLabel"])
    ax.set_ylabel(spec["yLabel"] or ("Count" if kind == "histogram" else ""))
    stem = f"chart-{index}"
    # Save with stable SVG text and no external TeX/browser services.
    fig.savefig(directory / f"{stem}.svg", metadata={"Date": None})
    fig.savefig(directory / f"{stem}.png", dpi=160)
    plt.close(fig)
    parts, notes = terminal_parts(spec)
    return {"kind": kind, "title": spec["title"], "seriesCount": len(series),
            "pointCount": sum(len(s.get("values", s.get("y", []))) for s in series),
            "stem": stem, "notes": spec["notes"] + notes, "parts": parts}


def main():
    request_path, directory = Path(sys.argv[1]), Path(sys.argv[2])
    data = read_input(json.loads(request_path.read_text()))
    plots = data["plots"] if isinstance(data, dict) and set(data) == {"plots"} else [data]
    if not isinstance(plots, list) or not 1 <= len(plots) <= 8:
        raise ValueError("A plot file must contain 1–8 charts.")
    validated = [validate(plot)[0] for plot in plots]
    (directory / "spec.json").write_text(json.dumps({"plots": validated}, allow_nan=False) + "\n")
    charts = [render(plot, i + 1, directory) for i, plot in enumerate(validated)]
    (directory / "rendered.json").write_text(json.dumps(charts, allow_nan=False) + "\n")
    print(json.dumps({"charts": len(charts), "renderer": f"matplotlib {matplotlib.__version__}"}))


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (ValueError, TypeError, KeyError, OSError, csv.Error) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
