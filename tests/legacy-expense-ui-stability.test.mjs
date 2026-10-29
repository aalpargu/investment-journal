import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../public/legacy/app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../public/legacy/styles.css", import.meta.url), "utf8");

const toggleStart = app.indexOf("function toggleExpenseFamily(");
const toggleEnd = app.indexOf("\nfunction deleteExpense(", toggleStart);
const toggleExpenseFamily = app.slice(toggleStart, toggleEnd);

assert.match(app, /function renderExpenses\(\{ preserveRows = false \} = \{\}\)/);
assert.match(app, /const selected = expenses\.filter\(expense => expenseReportingMonth\(expense, inferredMonths\) === expenseView\.month\)/);
assert.match(toggleExpenseFamily, /row\.classList\.toggle\("is-family", family\)/);
assert.match(toggleExpenseFamily, /renderExpenses\(\{ preserveRows: true \}\)/);
assert.doesNotMatch(toggleExpenseFamily, /\brenderExpenses\(\);/);
assert.doesNotMatch(app, /void element\.offsetWidth/);
assert.match(styles, /\.page\.active \{ animation: none; \}/);
assert.doesNotMatch(styles, /\.expense-row \{[^}]*animation:/);
assert.doesNotMatch(styles, /\.mobile-bottom-nav \{[^}]*backdrop-filter:/);

const helperStart = app.indexOf("function dominantExpenseMonth(");
const helperEnd = app.indexOf("\nfunction renderExpenseTrend(", helperStart);
const helperContext = { expenseMonthKey: date => String(date).slice(0, 7) };
vm.createContext(helperContext);
vm.runInContext(app.slice(helperStart, helperEnd), helperContext);
const statement = [
  { date: "2026-08-03", statementName: "agustos.pdf" },
  { date: "2026-08-31", statementName: "agustos.pdf" },
  { date: "2026-09-02", statementName: "agustos.pdf" }
];
const inferredMonths = helperContext.inferredExpenseStatementMonths(statement);
assert.equal(helperContext.dominantExpenseMonth(statement), "2026-08");
assert.equal(helperContext.expenseReportingMonth(statement[2], inferredMonths), "2026-08");

console.log("Legacy expense UI stability checks passed.");
