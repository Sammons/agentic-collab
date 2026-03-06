#!/usr/bin/env node
/**
 * CLI for the agent orchestrator.
 * Zero-dependency argument parsing. Calls orchestrator HTTP API.
 *
 * Usage:
 *   agent list
 *   agent create <name> --engine claude --cwd /path [--model X] [--thinking Y] [--persona Z] [--proxy P]
 *   agent spawn <name> [--task "..."] [--proxy P]
 *   agent resume <name> [--task "..."]
 *   agent suspend <name>
 *   agent reload <name> [--immediate] [--task "..."]
 *   agent interrupt <name>
 *   agent compact <name>
 *   agent kill <name>
 *   agent destroy <name>
 *   agent status <name>
 *   agent send --from <name> --to <name> --message "..." [--re "topic"]
 *
 *   orchestrator status
 *   orchestrator shutdown
 *   orchestrator restore
 *
 *   workstream list
 *   workstream create <name> --goal "..." [--plan "..."] [--agents a,b,c]
 */

const BASE_URL = process.env['ORCHESTRATOR_URL'] ?? 'http://localhost:3000';

type Args = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { positional, flags };
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${BASE_URL}${path}`, opts);
  const data = await resp.json();

  if (!resp.ok) {
    const err = (data as Record<string, unknown>).error ?? resp.statusText;
    throw new Error(`${method} ${path}: ${err}`);
  }

  return data;
}

function formatAgent(a: Record<string, unknown>): string {
  const state = a.state as string;
  const engine = a.engine as string;
  const model = a.model ? ` ${a.model}` : '';
  const thinking = a.thinking ? ` (${a.thinking})` : '';
  const ctx = a.lastContextPct != null ? ` ctx:${a.lastContextPct}%` : '';
  const proxy = a.proxyId ? ` proxy:${a.proxyId}` : ' (no proxy)';
  return `  ${a.name}  [${state}]  ${engine}${model}${thinking}${ctx}${proxy}`;
}

function formatTable(data: Record<string, unknown>[]): string {
  if (data.length === 0) return '  (none)';
  return data.map(formatAgent).join('\n');
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [domain, command, ...rest] = args.positional;

  if (!domain) {
    console.log('Usage: agentic <agent|orchestrator|workstream> <command> [options]');
    process.exit(1);
  }

  try {
    switch (domain) {
      case 'agent':
        await handleAgent(command, rest, args.flags);
        break;
      case 'orchestrator':
        await handleOrchestrator(command, args.flags);
        break;
      case 'workstream':
        await handleWorkstream(command, rest, args.flags);
        break;
      default:
        console.error(`Unknown domain: ${domain}`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function handleAgent(
  command: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const name = rest[0];

  switch (command) {
    case 'list': {
      const agents = await api('GET', '/api/agents') as Record<string, unknown>[];
      console.log('Agents:');
      console.log(formatTable(agents));
      break;
    }

    case 'create': {
      if (!name) throw new Error('Usage: agent create <name> --engine <e> --cwd <path>');
      if (!flags.engine || !flags.cwd) throw new Error('--engine and --cwd are required');

      const result = await api('POST', '/api/agents', {
        name,
        engine: flags.engine,
        cwd: flags.cwd,
        model: flags.model ?? null,
        thinking: flags.thinking ?? null,
        persona: flags.persona ?? null,
        proxyId: flags.proxy ?? null,
      });
      console.log(`Created agent: ${(result as Record<string, unknown>).name}`);
      break;
    }

    case 'spawn': {
      if (!name) throw new Error('Usage: agent spawn <name>');
      const result = await api('POST', `/api/agents/${encodeURIComponent(name)}/spawn`, {
        task: flags.task ?? undefined,
        proxyId: flags.proxy ?? undefined,
      });
      console.log(`Spawned agent: ${(result as Record<string, unknown>).name} [${(result as Record<string, unknown>).state}]`);
      break;
    }

    case 'resume': {
      if (!name) throw new Error('Usage: agent resume <name>');
      const result = await api('POST', `/api/agents/${encodeURIComponent(name)}/resume`, {
        task: flags.task ?? undefined,
      });
      console.log(`Resumed agent: ${(result as Record<string, unknown>).name} [${(result as Record<string, unknown>).state}]`);
      break;
    }

    case 'suspend': {
      if (!name) throw new Error('Usage: agent suspend <name>');
      const result = await api('POST', `/api/agents/${encodeURIComponent(name)}/suspend`);
      console.log(`Suspended agent: ${(result as Record<string, unknown>).name}`);
      break;
    }

    case 'reload': {
      if (!name) throw new Error('Usage: agent reload <name>');
      const result = await api('POST', `/api/agents/${encodeURIComponent(name)}/reload`, {
        immediate: flags.immediate === true,
        task: flags.task ?? undefined,
      });
      const r = result as Record<string, unknown>;
      console.log(`Reload ${r.reloadQueued ? 'queued' : 'completed'} for: ${r.name}`);
      break;
    }

    case 'interrupt': {
      if (!name) throw new Error('Usage: agent interrupt <name>');
      await api('POST', `/api/agents/${encodeURIComponent(name)}/interrupt`);
      console.log(`Interrupted agent: ${name}`);
      break;
    }

    case 'compact': {
      if (!name) throw new Error('Usage: agent compact <name>');
      await api('POST', `/api/agents/${encodeURIComponent(name)}/compact`);
      console.log(`Compact requested for: ${name}`);
      break;
    }

    case 'kill': {
      if (!name) throw new Error('Usage: agent kill <name>');
      await api('POST', `/api/agents/${encodeURIComponent(name)}/kill`);
      console.log(`Killed agent: ${name}`);
      break;
    }

    case 'destroy': {
      if (!name) throw new Error('Usage: agent destroy <name>');
      await api('POST', `/api/agents/${encodeURIComponent(name)}/destroy`);
      console.log(`Destroyed agent: ${name}`);
      break;
    }

    case 'status': {
      if (!name) throw new Error('Usage: agent status <name>');
      const agent = await api('GET', `/api/agents/${encodeURIComponent(name)}`) as Record<string, unknown>;
      console.log(JSON.stringify(agent, null, 2));
      break;
    }

    case 'send': {
      if (!flags.from || !flags.to || !flags.message) {
        throw new Error('Usage: agent send --from <name> --to <name> --message "..."');
      }
      const result = await api('POST', '/api/agents/send', {
        from: flags.from,
        to: flags.to,
        message: flags.message,
        re: flags.re ?? undefined,
      });
      console.log(`Message sent: ${(result as Record<string, unknown>).messageId}`);
      break;
    }

    case 'events': {
      if (!name) throw new Error('Usage: agent events <name>');
      const limit = flags.limit ? (parseInt(flags.limit as string, 10) || 20) : 20;
      const events = await api('GET', `/api/events/${encodeURIComponent(name)}?limit=${limit}`) as Record<string, unknown>[];
      for (const e of events) {
        const meta = e.meta ? ` ${e.meta}` : '';
        console.log(`  [${e.createdAt}] ${e.event}${meta}`);
      }
      break;
    }

    default:
      console.error(`Unknown agent command: ${command}`);
      console.error('Commands: list, create, spawn, resume, suspend, reload, interrupt, compact, kill, destroy, status, send, events');
      process.exit(1);
  }
}

async function handleOrchestrator(
  command: string | undefined,
  _flags: Record<string, string | boolean>,
): Promise<void> {
  switch (command) {
    case 'status': {
      const status = await api('GET', '/api/orchestrator/status') as Record<string, unknown>;
      console.log(JSON.stringify(status, null, 2));
      break;
    }

    case 'shutdown': {
      const result = await api('POST', '/api/orchestrator/shutdown') as Record<string, unknown>;
      console.log(`Shutdown: suspended ${result.suspended} agents`);
      break;
    }

    case 'restore': {
      const result = await api('POST', '/api/orchestrator/restore') as Record<string, unknown>;
      console.log(`Restore: resumed ${result.restored} agents`);
      break;
    }

    default:
      console.error(`Unknown orchestrator command: ${command}`);
      console.error('Commands: status, shutdown, restore');
      process.exit(1);
  }
}

async function handleWorkstream(
  command: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  switch (command) {
    case 'list': {
      const workstreams = await api('GET', '/api/workstreams') as Record<string, unknown>[];
      if (workstreams.length === 0) {
        console.log('  (none)');
      } else {
        for (const ws of workstreams) {
          console.log(`  ${ws.name}  [${ws.status}]  ${ws.goal}`);
        }
      }
      break;
    }

    case 'create': {
      const name = rest[0];
      if (!name || !flags.goal) throw new Error('Usage: workstream create <name> --goal "..."');

      const agents = typeof flags.agents === 'string'
        ? flags.agents.split(',').map((s) => s.trim())
        : undefined;

      await api('POST', '/api/workstreams', {
        name,
        goal: flags.goal,
        plan: flags.plan ?? null,
        agents,
      });
      console.log(`Created workstream: ${name}`);
      break;
    }

    default:
      console.error(`Unknown workstream command: ${command}`);
      console.error('Commands: list, create');
      process.exit(1);
  }
}

run();
