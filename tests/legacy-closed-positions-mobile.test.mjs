import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../public/legacy/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../public/legacy/index.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../public/legacy/styles.css", import.meta.url), "utf8");

assert.match(html, /class="table-wrap closed-table-wrap"/);
assert.match(html, /class="closed-positions-table"/);
assert.match(html, /id="closedSelectAllCheckbox"/);
assert.match(html, /id="closedSelectionBar"/);
assert.match(html, /id="closedQuickSelect"/);
assert.match(html, /id="closedExportSelectionButton"/);
assert.match(app, /class="closed-position-row\$\{isGroup/);
assert.match(app, /Core\.groupClosedPositionsForDisplay\(filtered\)/);
assert.match(app, /closed-position-group-row/);
assert.match(app, /closed-position-detail-row/);
assert.match(app, /closed-group-toggle/);
assert.match(app, /summarizeClosedPositionSelection/);
assert.match(app, /event\.shiftKey/);
assert.match(app, /exportSelectedClosedPositions/);
assert.match(app, /closed-selection-chart-row/);
for (const label of ["Varlık", "Lot", "Alış fiyatı", "Satış fiyatı", "Gerçekleşen K\/Z", "Getiri"]) {
  assert.match(app, new RegExp(`data-label="${label}"`));
}
assert.match(styles, /#closedPage \.closed-table-wrap \{ overflow: visible; \}/);
assert.match(styles, /#closedPositionsTable \.closed-position-row \{[^}]*display: grid;/);
assert.match(styles, /#closedPositionsTable \.closed-symbol-cell \{[^}]*order: 1;/);
assert.match(styles, /#closedPositionsTable \.closed-pnl-cell \{[^}]*order: 2;/);
assert.match(styles, /\.closed-position-group-row \{/);
assert.match(styles, /\.closed-position-detail-row td:first-child \{/);
assert.match(styles, /\.closed-selection-bar \{/);
assert.match(styles, /\.closed-selection-metrics \{/);

console.log("Closed positions mobile layout checks passed.");
