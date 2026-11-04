import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SetupPrompt, isModelNotConfiguredError } from '../ModelSetupPrompt';

describe('isModelNotConfiguredError', () => {
    it('recognizes the runtime code inside an Electron IPC rejection', () => {
        const ipc = new Error("Error invoking remote method 'data-agent:command': Error: LLM_NOT_CONFIGURED: add a model API key in Settings → Model");
        expect(isModelNotConfiguredError(ipc)).toBe(true);
        expect(isModelNotConfiguredError(new Error('LLM_NOT_CONFIGURED'))).toBe(true);
    });

    it('ignores other failures', () => {
        expect(isModelNotConfiguredError(new Error('DataAgent HTTP command failed: 500'))).toBe(false);
        expect(isModelNotConfiguredError(undefined)).toBe(false);
    });
});

describe('SetupPrompt', () => {
    it('counts the missing steps and sends the user to the first one', () => {
        const onConfigure = vi.fn();
        render(<SetupPrompt remaining={2} next="model" onConfigure={onConfigure} />);
        expect(screen.getByText('还差 2 步即可开始')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '配置模型' }));
        expect(onConfigure).toHaveBeenCalledTimes(1);
    });

    it('names the database when only it is missing', () => {
        render(<SetupPrompt remaining={1} next="database" onConfigure={() => undefined} />);
        expect(screen.getByText('还差 1 步即可开始')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '连接数据库' })).toBeInTheDocument();
    });
});
