import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  assignRoomMock,
  initDatabaseMock,
  emitStatusMock,
  loggerInfoMock,
  isValidGroupFolderMock,
} = vi.hoisted(() => ({
  assignRoomMock: vi.fn(),
  initDatabaseMock: vi.fn(),
  emitStatusMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  isValidGroupFolderMock: vi.fn(() => true),
}));

vi.mock('../src/config.js', () => ({
  GROUPS_DIR: '/tmp/ejclaw-groups',
}));

vi.mock('../src/db.js', () => ({
  assignRoom: assignRoomMock,
  initDatabase: initDatabaseMock,
}));

vi.mock('../src/group-folder.js', () => ({
  isValidGroupFolder: isValidGroupFolderMock,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: loggerInfoMock,
  },
}));

vi.mock('./status.js', () => ({
  emitStatus: emitStatusMock,
}));

import { run } from './register.js';

describe('register step', () => {
  afterEach(() => {
    assignRoomMock.mockReset();
    initDatabaseMock.mockReset();
    emitStatusMock.mockReset();
    loggerInfoMock.mockReset();
    isValidGroupFolderMock.mockReset();
    isValidGroupFolderMock.mockReturnValue(true);
    vi.restoreAllMocks();
  });

  it('delegates room assignment to the canonical service without editing env or prompts', async () => {
    const mkdirSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    await run([
      '--jid',
      'dc:test-room',
      '--name',
      'Test Room',
      '--folder',
      'test-room',
    ]);

    expect(initDatabaseMock).toHaveBeenCalledTimes(1);
    expect(assignRoomMock).toHaveBeenCalledWith('dc:test-room', {
      name: 'Test Room',
      folder: 'test-room',
      isMain: false,
    });
    expect(mkdirSpy).toHaveBeenCalledWith('/tmp/ejclaw-groups/test-room/logs', {
      recursive: true,
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(emitStatusMock).toHaveBeenCalledWith('REGISTER_CHANNEL', {
      JID: 'dc:test-room',
      NAME: 'Test Room',
      FOLDER: 'test-room',
      CHANNEL: 'discord',
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
  });

  it('fails fast when deprecated assistant-name is passed', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit:${code}`);
      });

    await expect(
      run([
        '--jid',
        'dc:test-room',
        '--name',
        'Test Room',
        '--folder',
        'test-room',
        '--assistant-name',
        'Nova',
      ]),
    ).rejects.toThrow('process.exit:4');

    expect(initDatabaseMock).not.toHaveBeenCalled();
    expect(assignRoomMock).not.toHaveBeenCalled();
    expect(emitStatusMock).toHaveBeenCalledWith('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'assistant_name_option_removed',
      NEXT_STEP:
        'Use a dedicated assistant identity configuration command instead',
      LOG: 'logs/setup.log',
    });

    exitSpy.mockRestore();
  });

  it('never writes prompt or env files during registration', async () => {
    const mkdirSpy = vi
      .spyOn(fs, 'mkdirSync')
      .mockImplementation(() => undefined);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const writeSpy = vi.spyOn(fs, 'writeFileSync');

    await run([
      '--jid',
      'dc:main-room',
      '--name',
      'Main Room',
      '--folder',
      'main-room',
      '--is-main',
    ]);

    expect(assignRoomMock).toHaveBeenCalledWith('dc:main-room', {
      name: 'Main Room',
      folder: 'main-room',
      isMain: true,
    });
    expect(mkdirSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
