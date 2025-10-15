import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface PythonExecutionResult<T = unknown> {
    ok: boolean;
    data?: T;
    error?: string;
}

export class PythonService {
    private readonly scriptPath: string;

    public constructor(private readonly context: vscode.ExtensionContext) {
    this.scriptPath = vscode.Uri.joinPath(context.extensionUri, 'core.py').fsPath;
    }

    public async execute<T>(action: string, payload: Record<string, unknown>): Promise<T> {
        const request = {
            action,
            ...payload,
        };
        const rawResponse = await this.runPython(JSON.stringify(request));
        let parsed: PythonExecutionResult<T>;
        try {
            parsed = JSON.parse(rawResponse) as PythonExecutionResult<T>;
        } catch (error) {
            throw new Error(`无法解析 Python 返回结果: ${rawResponse}`);
        }

        if (!parsed.ok) {
            throw new Error(parsed.error ?? 'Python 执行失败');
        }

        if (!parsed.data) {
            throw new Error('Python 返回数据为空');
        }

        return parsed.data;
    }

    private runPython(input: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const pythonPath = this.getPythonPath();
            const child = spawn(pythonPath, [this.scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    PYTHONIOENCODING: 'utf-8',
                },
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                reject(error);
            });

            child.on('close', (code) => {
                if (code !== 0 && stderr) {
                    reject(new Error(stderr.trim() || `Python 进程退出码: ${code}`));
                    return;
                }
                resolve(stdout.trim());
            });

            child.stdin.write(input);
            child.stdin.end();
        });
    }

    private getPythonPath(): string {
        const config = vscode.workspace.getConfiguration('ojAssistant');
        return config.get<string>('pythonPath', 'python');
    }
}
