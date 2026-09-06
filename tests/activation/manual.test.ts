import { describe, expect, it } from 'vitest';
import { ManualActivationAdapter } from '../../src/activation/manual';
import type { ActivationDispatch } from '../../src/activation/types';

const DISPATCH: ActivationDispatch = {
  dispatchId: 'gf_r123_i42_consumer_01',
  role: 'consumer',
  issueNumber: 42,
  repository: 'owner/name',
};

function collect() {
  const lines: string[] = [];
  let bells = 0;
  return {
    lines,
    out: (line: string) => {
      lines.push(line);
    },
    bell: () => {
      bells += 1;
    },
    bellCount: () => bells,
  };
}

describe('ManualActivationAdapter (first-class citizen, not a fallback hack)', () => {
  it('probe() is always available', async () => {
    const adapter = new ManualActivationAdapter();
    const caps = await adapter.probe();

    expect(caps.available).toBe(true);
    expect(caps.detail).toContain('always available');
  });

  it('notify() prints dispatch id, workspace root, repository and gateflow instructions', async () => {
    const sink = collect();
    const adapter = new ManualActivationAdapter({ out: sink.out, bell: sink.bell });

    const result = await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(result).toEqual({ notified: true, detail: 'manual' });
    const notice = sink.lines.join('\n');
    expect(notice).toContain('gf_r123_i42_consumer_01');
    expect(notice).toContain('D:/code/demo');
    expect(notice).toContain('gateflow-agent');
    expect(notice).toContain('.gateflow/current.json');
    expect(notice).toContain('#42');
    expect(notice).toContain('owner/name');
    expect(notice).toContain('consumer');
  });

  it('notify() gives numbered step-by-step instructions (open client → skill → current.json)', async () => {
    const sink = collect();
    const adapter = new ManualActivationAdapter({ out: sink.out, bell: sink.bell });

    await adapter.notify(DISPATCH, 'D:/code/demo');

    const notice = sink.lines.join('\n');
    expect(notice).toMatch(/1\..*Open the project in ChatGPT \/ ZCode\./);
    expect(notice).toMatch(/2\..*load the gateflow-agent skill/);
    expect(notice).toMatch(/3\..*reads \.gateflow\/current\.json.*processes the dispatch/);
  });

  it('notify() emits a terminal bell best-effort', async () => {
    const sink = collect();
    const adapter = new ManualActivationAdapter({ out: sink.out, bell: sink.bell });

    await adapter.notify(DISPATCH, 'D:/code/demo');

    expect(sink.bellCount()).toBe(1);
  });

  it('exposes name "manual"', () => {
    expect(new ManualActivationAdapter().name).toBe('manual');
  });
});
