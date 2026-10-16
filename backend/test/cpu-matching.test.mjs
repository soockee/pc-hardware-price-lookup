import assert from "node:assert/strict";
import test from "node:test";
import { buildCpuSearchPlan, cpuSocket, matchCpuProduct, shouldSearchCpuFallback } from "../src/cpu-matching.ts";

test("Intel trademark annotations do not prevent identifying the Core Ultra 7 265K", () => {
  const name = "Intel(R) Core(TM) Ultra 7 265K";
  const plan = buildCpuSearchPlan(name);

  assert.equal(cpuSocket(name), "LGA1851");
  assert.equal(plan.exactModel, "265K");
  assert.equal(plan.query, "Intel Core Ultra 7 265K processor");
  assert.equal(plan.fallbackQuery, "Intel Core Ultra 7 LGA1851 processor");
  assert.equal(matchCpuProduct(name, plan, "Intel Core Ultra 7 265K Desktop Processor").matchType, "exact");
});

test("socket search runs only when the exact CPU was not found", () => {
  const plan = buildCpuSearchPlan("Intel(R) Core(TM) Ultra 7 265K");

  assert.equal(shouldSearchCpuFallback(plan, [{ matchType: "exact", matchLabel: "same CPU model" }]), false);
  assert.equal(shouldSearchCpuFallback(plan, [{ matchType: "similar", matchLabel: "LGA1851 · similar CPU" }]), true);
  assert.equal(shouldSearchCpuFallback(plan, []), true);
});

test("a different CPU on the same socket is retained as a similar alternative", () => {
  const name = "Intel(R) Core(TM) Ultra 7 265K";
  const plan = buildCpuSearchPlan(name);

  assert.deepEqual(matchCpuProduct(name, plan, "Intel Core Ultra 9 285K Desktop Processor"), {
    matchType: "similar",
    matchLabel: "LGA1851 · similar CPU",
  });
});

test("a CPU on another socket is not presented as a compatible alternative", () => {
  const name = "Intel(R) Core(TM) Ultra 7 265K";
  const plan = buildCpuSearchPlan(name);

  assert.equal(matchCpuProduct(name, plan, "Intel Core i9-14900K Desktop Processor"), null);
});

test("model suffixes are not mistaken for an exact CPU match", () => {
  const name = "Intel(R) Core(TM) Ultra 7 265K";
  const plan = buildCpuSearchPlan(name);

  assert.equal(matchCpuProduct(name, plan, "Intel Core Ultra 7 265KF Desktop Processor").matchType, "similar");
});
