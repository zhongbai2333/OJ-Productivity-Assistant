import * as vscode from 'vscode';
import { spawn } from 'child_process';

export interface PythonExecutionResult<T = unknown> {
    ok: boolean;
    data?: T;
    error?: string;
}

export class PythonService {
    private readonly scriptPath: string;
    private dependenciesReady = false;
    private dependencySetupPromise: Promise<void> | undefined;

    public constructor(private readonly context: vscode.ExtensionContext) {
        this.scriptPath = vscode.Uri.joinPath(context.extensionUri, 'core.py').fsPath;
    }

    public async execute<T>(action: string, payload: Record<string, unknown>): Promise<T> {
        const request = {
            action,
            ...payload,
        };
        await this.ensureDependencies();
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
        return this.runPythonProcess([this.scriptPath], input).then((result) => {
            if (result.exitCode !== 0 && result.stderr) {
                throw new Error(result.stderr.trim() || `Python 进程退出码: ${result.exitCode}`);
            }
            if (result.exitCode !== 0) {
                throw new Error(`Python 进程退出码: ${result.exitCode}`);
            }
            return result.stdout.trim();
        });
    }

    private getPythonPath(): string {
        const config = vscode.workspace.getConfiguration('ojAssistant');
        return config.get<string>('pythonPath', 'python');
    }

    private runPythonProcess(
        args: string[],
        input?: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
        return new Promise((resolve, reject) => {
            const pythonPath = this.getPythonPath();
            const child = spawn(pythonPath, args, {
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
                resolve({ stdout, stderr, exitCode: code });
            });

            if (typeof input === 'string') {
                child.stdin.write(input);
            }
            child.stdin.end();
        });
    }

    private async ensureDependencies(): Promise<void> {
        if (this.dependenciesReady) {
            return;
        }
        if (!this.dependencySetupPromise) {
            this.dependencySetupPromise = this.installDependenciesIfNeeded().finally(() => {
                this.dependencySetupPromise = undefined;
            });
        }
        await this.dependencySetupPromise;
        if (!this.dependenciesReady) {
            throw new Error('自动配置 Python 环境失败，请检查 Python 设置并手动安装 beautifulsoup4、requests、urllib3。');
        }
    }

    private async installDependenciesIfNeeded(): Promise<void> {
        const checkResult = await this.runPythonProcess(['-c', 'import bs4, requests, urllib3']);
        if (checkResult.exitCode === 0) {
            this.dependenciesReady = true;
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'OJ Assistant: 正在配置 Python 环境',
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: '正在安装依赖包…' });
                await this.installDependencies();
                progress.report({ message: '正在验证依赖…' });
                const verifyResult = await this.runPythonProcess(['-c', 'import bs4, requests, urllib3']);
                if (verifyResult.exitCode !== 0) {
                    const errorMessage = this.pickMeaningfulError(verifyResult.stderr, verifyResult.stdout);
                    throw new Error(
                        errorMessage ||
                            '依赖安装后校验失败，请手动运行 "python -m pip install beautifulsoup4 requests urllib3" 并重试。',
                    );
                }
            },
        );

        this.dependenciesReady = true;
    }

    private async installDependencies(): Promise<void> {
        const packages = ['beautifulsoup4', 'requests', 'urllib3'];
        let installResult = await this.runPythonProcess(['-m', 'pip', 'install', '--upgrade', ...packages]);
        if (installResult.exitCode !== 0 && /No module named pip/.test(installResult.stderr)) {
            const ensureResult = await this.runPythonProcess(['-m', 'ensurepip', '--upgrade']);
            if (ensureResult.exitCode !== 0) {
                const ensureError = this.pickMeaningfulError(ensureResult.stderr, ensureResult.stdout);
                throw new Error(
                    ensureError ||
                        '无法启用 pip，已停止自动安装。请手动运行 "python -m ensurepip --upgrade" 后再试。',
                );
            }
            installResult = await this.runPythonProcess(['-m', 'pip', 'install', '--upgrade', ...packages]);
        }
        if (installResult.exitCode !== 0) {
            const errorMessage = this.pickMeaningfulError(installResult.stderr, installResult.stdout);
            throw new Error(
                errorMessage ||
                    '自动安装 Python 依赖失败，请手动运行 "python -m pip install beautifulsoup4 requests urllib3" 再试。',
            );
        }
    }

    private pickMeaningfulError(stderr: string, stdout: string): string {
        const preferred = stderr?.trim() ?? '';
        if (preferred) {
            return preferred;
        }
        const fallback = stdout?.trim() ?? '';
        return fallback;
    }
}
