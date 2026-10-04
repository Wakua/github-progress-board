import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { emptyWorkspace, registerProject, addGoal, addTask } from '../dist/workspace.mjs';

// All identities, project names and work below are isolated QA fixtures, never deployment seeds.
export function fixtureWorkspace(suffix = 'one') {
  const workspace = emptyWorkspace();
  const project = registerProject(workspace, { name: `隔離QA ${suffix}`, repositoryUrl: `https://github.com/qa/${suffix}` }, () => `project-${suffix}`);
  addGoal(project.data, project.id, { title: '検証用目標', issueNumber: 1 }, () => `goal-${suffix}`);
  addTask(project.data, project.id, { title: '検証用作業', goalId: project.data.goals[0].id, issueNumber: 2, status: 'todo', criteria: ['検証用条件'] }, () => `task-${suffix}`);
  return workspace;
}
export function sqliteD1(filename = ':memory:', { migrate = true } = {}) {
  const sqlite = new DatabaseSync(filename);
  if (migrate) for (const name of readdirSync(new URL('../drizzle/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(`../drizzle/${name}`, import.meta.url), 'utf8'));
  let fault = null;
  const execute = statement => {
    if (fault?.(statement.sql)) { fault = null; throw new Error('Injected SQLite batch failure'); }
    const prepared = sqlite.prepare(statement.sql);
    const results = prepared.columns().length ? prepared.all(...statement.values) : (prepared.run(...statement.values), []);
    return { success: true, results, meta: { changes: sqlite.prepare('SELECT changes() AS changes').get().changes } };
  };
  const DB = {
    sqlite,
    prepare(sql) {
      const statement = { sql, values: [], bind(...values) { return { ...statement, values }; }, async first() { return execute(this).results[0] || null; }, async all() { return execute(this); }, async run() { return execute(this); } };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = statements.map(execute); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    failOnce(predicate) { fault = predicate; },
    close() { sqlite.close(); }
  };
  return DB;
}
export const memoryStorage = entries => {
  const values = new Map(Object.entries(entries || {}));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
};
