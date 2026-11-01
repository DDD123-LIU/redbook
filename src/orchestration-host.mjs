import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from './storage.mjs';
import { createOrchestrator } from './orchestrator.mjs';

const DAILY_SOURCES = new Set(['scheduled', 'periodic', 'recovery_startup', 'manual_daily']);

function readHostConfig(configPath) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) throw new TypeError('absolute configPath is required');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  for (const key of ['dbPath', 'root']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new TypeError(`absolute ${key} is required`);
  }
  for (const key of ['owner', 'appRef', 'targetRef', 'pageLabel']) {
    if (typeof config[key] !== 'string' || !config[key].trim()) throw new TypeError(`${key} is required`);
  }
  if (Object.hasOwn(config, 'productionEnabled') && typeof config.productionEnabled !== 'boolean') {
    throw new TypeError('productionEnabled must be a boolean');
  }
  if (!Number.isSafeInteger(config.taskSpaceId) || config.taskSpaceId < 1) {
    throw new TypeError('taskSpaceId must be a positive numeric id');
  }
  if (config.runtimeModule !== undefined
    && (typeof config.runtimeModule !== 'string' || !isAbsolute(config.runtimeModule))) {
    throw new TypeError('runtimeModule must be an absolute path');
  }
  return config;
}

async function loadRuntime(config, store, now) {
  if (!config.runtimeModule) return {};
  const module = await import(pathToFileURL(resolve(config.runtimeModule)).href);
  if (typeof module.createRuntime !== 'function') throw new TypeError('runtime module must export createRuntime');
  const runtime = await module.createRuntime({ config, store, now });
  if (!runtime || typeof runtime !== 'object') throw new TypeError('createRuntime must return a runtime object');
  return runtime;
}

async function bindConfiguredPage(config, taskSpace) {
  if (typeof taskSpace !== 'function') return undefined;
  try {
    const task = await taskSpace(config.taskSpaceId);
    if (!task || task.spaceId !== config.taskSpaceId || task.ownership !== 'agent') return undefined;
    const pages = await task.pages();
    const page = pages.find(candidate => candidate?.label === config.pageLabel);
    if (!page || typeof page.url !== 'function') return undefined;
    const currentUrl = new URL(await page.url());
    return currentUrl.origin === 'https://www.xiaohongshu.com' ? page : undefined;
  } catch {
    return undefined;
  }
}

export async function runTask013Host({ configPath, source, operation = 'daily', invocation = {}, taskSpace, now = () => new Date().toISOString() } = {}) {
  if (!DAILY_SOURCES.has(source)) throw new TypeError('source must be scheduled, periodic, recovery_startup or manual_daily');
  if (!['daily', 'recover', 'additional'].includes(operation)) throw new TypeError('operation must be daily, recover or additional');
  const config = readHostConfig(configPath);
  if (config.productionEnabled === false) throw new Error('production is disabled');
  if (operation === 'recover') {
    if (source !== 'manual_daily' || invocation?.explicitRequest !== true) {
      throw new TypeError('explicit manual_daily authorization is required for recovery');
    }
    if (typeof invocation.confirmedStoppedRunId !== 'string' || !invocation.confirmedStoppedRunId.trim()
        || typeof invocation.evidenceRef !== 'string' || !invocation.evidenceRef.trim()) {
      throw new TypeError('confirmedStoppedRunId and evidenceRef are required');
    }
  }
  if (operation === 'additional') {
    if (source !== 'manual_daily' || invocation?.explicitRequest !== true) {
      throw new TypeError('explicit manual_daily authorization is required for additional requests');
    }
    if (typeof invocation.commandId !== 'string' || !invocation.commandId.trim()
        || typeof invocation.requestText !== 'string' || !invocation.requestText.trim()) {
      throw new TypeError('commandId and requestText are required');
    }
  }
  const store = openStore(config.dbPath);
  try {
    const runtime = operation === 'recover' ? {} : await loadRuntime(config, store, now);
    const orchestrator = createOrchestrator({ store, root: config.root, owner: config.owner,
      appRef: config.appRef, targetRef: config.targetRef, runtime, now });
    if (operation === 'recover') {
      return await orchestrator.recoverCoordinator({
        confirmedStoppedRunId: invocation.confirmedStoppedRunId,
        evidenceRef: invocation.evidenceRef,
      });
    }
    const tab = await bindConfiguredPage(config, taskSpace);
    if (operation === 'additional') {
      return await orchestrator.run({ kind: 'additional_follow', commandId: invocation.commandId,
        requestText: invocation.requestText, requestSource: 'feedback', tab });
    }
    return await orchestrator.ensureDailyBatch({ tab });
  } finally {
    store.close();
  }
}
