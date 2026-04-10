import { describe, it, expect } from 'vitest';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from './config.js';
import {
  escapeXml,
  formatMessages,
  formatOutbound,
  stripInternalTags,
  stripToolCallLeaks,
} from './router.js';
import { NewMessage } from './types.js';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: '1',
    chat_jid: 'group@g.us',
    sender: '123@s.whatsapp.net',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// --- escapeXml ---

describe('escapeXml', () => {
  it('escapes ampersands', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('escapes less-than', () => {
    expect(escapeXml('a < b')).toBe('a &lt; b');
  });

  it('escapes greater-than', () => {
    expect(escapeXml('a > b')).toBe('a &gt; b');
  });

  it('escapes double quotes', () => {
    expect(escapeXml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('handles multiple special characters together', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot;',
    );
  });

  it('passes through strings with no special chars', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    expect(escapeXml('')).toBe('');
  });
});

// --- formatMessages ---

describe('formatMessages', () => {
  const TZ = 'UTC';

  it('formats a single message as XML with context header', () => {
    const result = formatMessages([makeMsg()], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<message sender="Alice"');
    expect(result).toContain('>hello</message>');
    expect(result).toContain('Jan 1, 2024');
  });

  it('formats multiple messages', () => {
    const msgs = [
      makeMsg({
        id: '1',
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2024-01-01T00:00:00.000Z',
      }),
      makeMsg({
        id: '2',
        sender_name: 'Bob',
        content: 'hey',
        timestamp: '2024-01-01T01:00:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, TZ);
    expect(result).toContain('sender="Alice"');
    expect(result).toContain('sender="Bob"');
    expect(result).toContain('>hi</message>');
    expect(result).toContain('>hey</message>');
  });

  it('escapes special characters in sender names', () => {
    const result = formatMessages([makeMsg({ sender_name: 'A & B <Co>' })], TZ);
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
  });

  it('escapes special characters in content', () => {
    const result = formatMessages(
      [makeMsg({ content: '<script>alert("xss")</script>' })],
      TZ,
    );
    expect(result).toContain(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
  });

  it('handles empty array', () => {
    const result = formatMessages([], TZ);
    expect(result).toContain('<context timezone="UTC" />');
    expect(result).toContain('<messages>\n\n</messages>');
  });

  it('converts timestamps to local time for given timezone', () => {
    // 2024-01-01T18:30:00Z in America/New_York (EST) = 1:30 PM
    const result = formatMessages(
      [makeMsg({ timestamp: '2024-01-01T18:30:00.000Z' })],
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('<context timezone="America/New_York" />');
  });
});

// --- TRIGGER_PATTERN ---

describe('TRIGGER_PATTERN', () => {
  const name = ASSISTANT_NAME;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();

  it('matches @name at start of message', () => {
    expect(TRIGGER_PATTERN.test(`@${name} hello`)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(TRIGGER_PATTERN.test(`@${lower} hello`)).toBe(true);
    expect(TRIGGER_PATTERN.test(`@${upper} hello`)).toBe(true);
  });

  it('does not match when not at start of message', () => {
    expect(TRIGGER_PATTERN.test(`hello @${name}`)).toBe(false);
  });

  it('does not match partial name like @NameExtra (word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}extra hello`)).toBe(false);
  });

  it('matches with word boundary before apostrophe', () => {
    expect(TRIGGER_PATTERN.test(`@${name}'s thing`)).toBe(true);
  });

  it('matches @name alone (end of string is a word boundary)', () => {
    expect(TRIGGER_PATTERN.test(`@${name}`)).toBe(true);
  });

  it('matches with leading whitespace after trim', () => {
    // The actual usage trims before testing: TRIGGER_PATTERN.test(m.content.trim())
    expect(TRIGGER_PATTERN.test(`@${name} hey`.trim())).toBe(true);
  });
});

// --- Outbound formatting (internal tag stripping + prefix) ---

describe('stripInternalTags', () => {
  it('strips single-line internal tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multi-line internal tags', () => {
    expect(
      stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world'),
    ).toBe('hello  world');
  });

  it('strips multiple internal tag blocks', () => {
    expect(
      stripInternalTags('<internal>a</internal>hello<internal>b</internal>'),
    ).toBe('hello');
  });

  it('returns empty string when text is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

describe('formatOutbound', () => {
  it('returns text with internal tags stripped', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('returns empty string when all text is internal', () => {
    expect(formatOutbound('<internal>hidden</internal>')).toBe('');
  });

  it('strips internal tags from remaining text', () => {
    expect(
      formatOutbound('<internal>thinking</internal>The answer is 42'),
    ).toBe('The answer is 42');
  });
});

// --- Tool-call leak stripping ---

describe('stripToolCallLeaks', () => {
  it('strips a single tool-call serialization line', () => {
    const input =
      'to=functions.exec_command code {"cmd":"git status","yield_time_ms":1000,"max_output_tokens":200}';
    expect(stripToolCallLeaks(input)).toBe('');
  });

  it('strips tool-call text surrounded by normal text', () => {
    const input = 'Hello\nto=functions.exec_command code {"cmd":"ls"}\nWorld';
    expect(stripToolCallLeaks(input)).toBe('Hello\n\nWorld');
  });

  it('strips multiple consecutive tool-call lines', () => {
    const call =
      'to=functions.exec_command code {"cmd":"git status --short && git rev-parse --short HEAD","yield_time_ms":1000,"max_output_tokens":200}';
    const input = `${call}\n${call}\n${call}`;
    expect(stripToolCallLeaks(input)).toBe('');
  });

  it('strips tool-call with nested JSON braces', () => {
    const input =
      'to=functions.exec_command code {"cmd":"echo hello","options":{"verbose":true}}';
    expect(stripToolCallLeaks(input)).toBe('');
  });

  it('preserves normal text mentioning functions in prose', () => {
    const input = 'The model called to=functions but with wrong syntax';
    // No match: missing the <word> <{json}> part
    expect(stripToolCallLeaks(input)).toBe(input);
  });

  it('preserves code blocks discussing tool calls', () => {
    const input = '```\nto=functions.exec_command code {"cmd":"ls"}\n```';
    // The tool-call inside backticks still gets stripped — this is intentional.
    // Defense layer prioritizes safety over preserving code examples.
    expect(stripToolCallLeaks(input)).toBe('```\n\n```');
  });

  it('collapses excessive blank lines after stripping', () => {
    const input =
      'Before\n\nto=functions.exec_command code {"cmd":"ls"}\n\n\n\nAfter';
    const result = stripToolCallLeaks(input);
    expect(result).toBe('Before\n\nAfter');
  });

  it('handles different function names', () => {
    expect(
      stripToolCallLeaks(
        'to=functions.read_file code {"path":"/tmp/test.txt"}',
      ),
    ).toBe('');
    expect(
      stripToolCallLeaks(
        'to=functions.write_file code {"path":"/tmp/out","content":"hi"}',
      ),
    ).toBe('');
  });

  it('returns original text when no tool-call patterns present', () => {
    const input = 'This is a perfectly normal response with no issues.';
    expect(stripToolCallLeaks(input)).toBe(input);
  });

  it('returns empty string for empty input', () => {
    expect(stripToolCallLeaks('')).toBe('');
  });

  it('strips tool-call leaks with CJK/non-ASCII garbage between tokens', () => {
    const cjkLeak =
      'to=functions.exec_command  彩神争霸大发快三 json code {"cmd":"printf \'noop\\n\'","yield_time_ms":1000,"max_output_tokens":20}';
    expect(stripToolCallLeaks(cjkLeak)).toBe('');
  });

  it('strips tool-call leaks with mixed non-ASCII and preserves surrounding text', () => {
    const mixed =
      '대기 중입니다.to=functions.exec_command  彩神争霸 json code {"cmd":"ls"}\n다음 작업';
    expect(stripToolCallLeaks(mixed)).toBe('대기 중입니다.\n다음 작업');
  });

  it('strips tool-call leaks with multiple non-ASCII words before JSON', () => {
    const leak =
      'to=functions.read_file données café résumé code {"path":"/tmp/test"}';
    expect(stripToolCallLeaks(leak)).toBe('');
  });
});

describe('formatOutbound with tool-call leaks', () => {
  it('strips tool-call leaks and returns empty for pure garbage', () => {
    const garbage =
      'to=functions.exec_command code {"cmd":"git status","yield_time_ms":1000}';
    expect(formatOutbound(garbage)).toBe('');
  });

  it('preserves legitimate text while stripping tool-call leaks', () => {
    const mixed =
      'Here is my answer.\nto=functions.exec_command code {"cmd":"ls"}\nHope this helps!';
    expect(formatOutbound(mixed)).toBe(
      'Here is my answer.\n\nHope this helps!',
    );
  });

  it('strips internal tags AND tool-call leaks together', () => {
    const input =
      '<internal>thinking</internal>to=functions.exec_command code {"cmd":"ls"}Done!';
    expect(formatOutbound(input)).toBe('Done!');
  });

  it('redacts secrets in remaining text after tool-call strip', () => {
    const input =
      'Key: sk-ant-XXXXXXXXXXXXXXXXXXXXXXXX\nto=functions.exec_command code {"cmd":"ls"}';
    expect(formatOutbound(input)).toBe('Key: [REDACTED]');
  });
});
