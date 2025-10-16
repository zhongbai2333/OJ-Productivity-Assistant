import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { PythonService } from './pythonService';

interface PersistedProblemsetState {
    readonly data: Record<string, unknown>;
    readonly request: { startPage: number; maxPages: number };
}

interface PersistedProblemState {
    readonly problemId: number;
    readonly data: unknown;
    readonly fetchedAt: number;
}

interface PersistedSession {
    savedAt: number;
    userId: string;
    rememberPassword: boolean;
    passwordHash?: string;
    currentProblemId?: number;
    problemset?: PersistedProblemsetState;
    lastProblem?: PersistedProblemState;
    preferredLanguage?: string;
}

interface SessionState {
    readonly cookies: Record<string, string>;
    readonly userId: string;
}

type WebviewMessage =
    | { type: 'login'; payload: { username: string; password: string; remember: boolean; useSavedPassword?: boolean } }
    | { type: 'fetchProblemset'; payload: { startPage: number; maxPages?: number | null } }
    | { type: 'fetchProblem'; payload: { problemId: number } }
    | { type: 'fetchStatus'; payload: { limit: number } }
    | { type: 'createFile'; payload: { problemId: number; language: string } }
    | { type: 'submitSolution'; payload: { problemId: number; language: string; filePath: string; contestProblemId?: number | null } }
    | { type: 'selectProblem'; payload: { problemId: number | null } }
    | { type: 'runSampleTest'; payload: { problemId: number | null; language: string; filePath: string; sampleInput: string; expectedOutput?: string | null } }
    | { type: 'updateProblemStatus'; payload: { problemId: number; accepted: boolean } }
    | { type: 'setPreferredLanguage'; payload: { language: string } };

export function activate(context: vscode.ExtensionContext) {
    const provider = new OJAssistantProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('ojAssistant.dashboard', provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ojAssistant.openDashboard', () => provider.reveal()),
    );
}

export function deactivate() { }

class OJAssistantProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView;
    private readonly python: PythonService;
    private session: SessionState | undefined;
    private currentProblemId: number | null = null;
    private sessionRestorePromise: Promise<void> | undefined;
    private savedCredentials: { userId: string; passwordHash?: string; rememberPassword: boolean } | undefined;
    private autoLoginPromise: Promise<boolean> | undefined;
    private readonly stateDirName = '.oj-assistant';
    private readonly stateFileName = 'session.json';
    private warnedMissingWorkspace = false;
    private preferredLanguage = 'python';

    public constructor(private readonly context: vscode.ExtensionContext) {
        this.python = new PythonService(context);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewView.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message as WebviewMessage);
        });
        webviewView.webview.html = this.renderHtml(webviewView.webview);
        this.sessionRestorePromise = this.tryRestoreSession();
        void this.sessionRestorePromise;
    }

    public reveal(): void {
        if (this.view) {
            this.view.show?.(true);
        } else {
            void vscode.commands.executeCommand('workbench.view.extension.ojAssistant');
        }
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'login':
                    await this.handleLogin(
                        message.payload.username,
                        message.payload.password,
                        message.payload.remember,
                        message.payload.useSavedPassword ?? false,
                    );
                    break;
                case 'fetchProblemset':
                    await this.handleFetchProblemset(message.payload.startPage, message.payload.maxPages ?? undefined);
                    break;
                case 'fetchProblem':
                    await this.handleFetchProblem(message.payload.problemId);
                    break;
                case 'fetchStatus':
                    await this.handleFetchStatus(message.payload.limit);
                    break;
                case 'createFile':
                    await this.handleCreateFile(message.payload.problemId, message.payload.language);
                    break;
                case 'submitSolution':
                    await this.handleSubmitSolution(
                        message.payload.problemId,
                        message.payload.language,
                        message.payload.filePath,
                        message.payload.contestProblemId ?? undefined,
                    );
                    break;
                case 'selectProblem':
                    await this.handleSelectProblem(message.payload.problemId);
                    break;
                case 'runSampleTest':
                    await this.handleRunSampleTest(
                        message.payload.problemId,
                        message.payload.language,
                        message.payload.filePath,
                        message.payload.sampleInput,
                        message.payload.expectedOutput ?? undefined,
                    );
                    break;
                case 'setPreferredLanguage':
                    await this.persistPreferredLanguage(message.payload.language);
                    break;
                case 'updateProblemStatus':
                    await this.handleUpdateProblemStatus(message.payload.problemId, message.payload.accepted);
                    break;
                default:
                    throw new Error(`未知消息类型: ${(message as { type: string }).type}`);
            }
        } catch (error) {
            const messageType = (message as { type: string }).type ?? 'unknown';
            this.postMessage({ type: 'error', message: (error as Error).message, context: messageType });
        }
    }

    private async handleLogin(username: string, password: string, remember: boolean, useSavedPassword: boolean): Promise<void> {
        const trimmedUsername = username.trim();
        if (!trimmedUsername) {
            throw new Error('请填写用户名');
        }

        let passwordHash: string | undefined;
        let cookies: Record<string, string>;

        if (useSavedPassword) {
            const saved = this.savedCredentials;
            if (!saved || !saved.passwordHash || saved.userId !== trimmedUsername) {
                throw new Error('未找到已保存的密码，请重新输入密码');
            }
            const data = await this.python.execute<{ cookies: Record<string, string> }>('login', {
                username: trimmedUsername,
                password_hash: saved.passwordHash,
            });
            cookies = data.cookies;
            passwordHash = remember ? saved.passwordHash : undefined;
        } else {
            if (!password) {
                throw new Error('请填写密码');
            }
            const data = await this.python.execute<{ cookies: Record<string, string> }>('login', {
                username: trimmedUsername,
                password,
            });
            cookies = data.cookies;
            passwordHash = remember ? this.hashPassword(password) : undefined;
        }

        this.session = { cookies, userId: trimmedUsername };
        this.currentProblemId = null;
        await this.recordLogin(trimmedUsername, remember, passwordHash, { clearCachedData: true });
        this.postMessage({
            type: 'loginSuccess',
            userId: trimmedUsername,
            rememberPassword: remember,
            hasSavedPassword: this.hasSavedPassword(),
            preferredLanguage: this.preferredLanguage,
        });
    }

    private async handleFetchProblemset(startPage: number, maxPages?: number): Promise<void> {
        const normalizedStartPage = Math.max(1, startPage);
        const effectiveMaxPages = typeof maxPages === 'number' && !Number.isNaN(maxPages) ? Math.max(1, maxPages) : 1;
        const data = await this.executeWithSession((session) =>
            this.python.execute<{ problemset: Record<string, unknown> }>('fetch_problemset', {
                cookies: session.cookies,
                start_page: normalizedStartPage,
                max_pages: effectiveMaxPages,
            }),
        );

    this.postMessage({ type: 'problemset', payload: data.problemset });
        await this.mutatePersistedSession((persisted) => {
            persisted.problemset = {
                data: data.problemset,
                request: {
                    startPage: normalizedStartPage,
                    maxPages: effectiveMaxPages,
                },
            };
        });
    }

    private async handleFetchProblem(problemId: number): Promise<void> {
        this.currentProblemId = problemId;
        const data = await this.executeWithSession((session) =>
            this.python.execute<{ problem: unknown }>('fetch_problem', {
                cookies: session.cookies,
                problem_id: problemId,
            }),
        );
        this.postMessage({ type: 'problem', payload: data.problem });
        await this.mutatePersistedSession((persisted) => {
            persisted.currentProblemId = problemId;
            if (data.problem !== undefined) {
                persisted.lastProblem = {
                    problemId,
                    data: data.problem,
                    fetchedAt: Date.now(),
                };
            } else {
                delete persisted.lastProblem;
            }
        });
    }

    private async handleFetchStatus(limit: number): Promise<void> {
        const data = await this.executeWithSession((session) =>
            this.python.execute<{ status: unknown }>('fetch_status', {
                cookies: session.cookies,
                user_id: session.userId,
                limit,
            }),
        );
    this.postMessage({ type: 'status', payload: data.status });
    }

    private async handleCreateFile(problemId: number, language: string): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('请先打开一个工作区目录');
        }

        const config = vscode.workspace.getConfiguration('ojAssistant');
        const directoryName = config.get<string>('codeDirectory', 'oj-workspace');
        const folderUri = vscode.Uri.joinPath(workspaceFolder.uri, directoryName);
        await this.ensureDirectory(folderUri);

        const extension = this.getExtensionForLanguage(language);
        let fileUri: vscode.Uri;
        if (language === 'java') {
            const problemFolder = vscode.Uri.joinPath(folderUri, `problem_${problemId}`);
            await this.ensureDirectory(problemFolder);
            fileUri = vscode.Uri.joinPath(problemFolder, 'Main.java');
        } else {
            const fileName = `problem_${problemId}.${extension}`;
            fileUri = vscode.Uri.joinPath(folderUri, fileName);
        }

        const exists = await this.fileExists(fileUri);
        if (!exists) {
            const template = this.getTemplateForLanguage(language, problemId);
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(template, 'utf8'));
        }

        const document = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(document);

    const relativePath = vscode.workspace.asRelativePath(fileUri);
    this.postMessage({ type: 'fileCreated', path: relativePath });
    await this.persistPreferredLanguage(language);
    }

    private async handleSubmitSolution(problemId: number, language: string, filePath: string, contestProblemId?: number): Promise<void> {
        await this.withAutoRelogin(async () => {
            const session = await this.ensureSession();
            const languageCode = this.getLanguageCode(language);
            const fileUri = this.resolveFileUri(filePath);
            const sourceBuffer = await vscode.workspace.fs.readFile(fileUri);
            const sourceCode = Buffer.from(sourceBuffer).toString('utf8');

            const submission = await this.python.execute<{ submission: { solution_id?: number } }>('submit_solution', {
                cookies: session.cookies,
                user_id: session.userId,
                problem_id: problemId,
                source_code: sourceCode,
                language: languageCode,
                contest_problem_id: contestProblemId ?? 0,
            });

            this.postMessage({ type: 'submission', payload: submission.submission });

            const solutionId = submission.submission.solution_id;
            if (typeof solutionId === 'number') {
                const finalStatus = await this.python.execute<{ status: unknown }>('poll_submission', {
                    cookies: session.cookies,
                    solution_id: solutionId,
                });
                this.postMessage({ type: 'submissionStatus', payload: finalStatus.status });
            }
        });
    }

    private async handleRunSampleTest(
        problemId: number | null,
        language: string,
        filePath: string,
        sampleInput: string,
        expectedOutput?: string,
    ): Promise<void> {
        try {
            if (!filePath) {
                throw new Error('请先指定代码文件路径');
            }
            if (!sampleInput) {
                throw new Error('当前题目缺少样例输入');
            }
            const fileUri = this.resolveFileUri(filePath);
            const exists = await this.fileExists(fileUri);
            if (!exists) {
                throw new Error('代码文件不存在，请先创建或保存后再试');
            }

            const result = await this.runSampleTest(language, fileUri.fsPath, sampleInput, expectedOutput);
            this.postMessage({
                type: 'sampleTestResult',
                payload: {
                    ok: true,
                    language,
                    filePath,
                    problemId,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    matched: result.matched,
                    expectedOutput: expectedOutput ?? null,
                },
            });
        } catch (error) {
            this.postMessage({
                type: 'sampleTestResult',
                payload: {
                    ok: false,
                    language,
                    filePath,
                    problemId,
                    error: (error as Error).message,
                },
            });
        }
    }

    private async handleUpdateProblemStatus(problemId: number, accepted: boolean): Promise<void> {
        const numericId = Number(problemId);
        if (!Number.isFinite(numericId)) {
            return;
        }

        await this.mutatePersistedSession((persisted) => {
            const problemsetData = persisted.problemset?.data;
            if (!problemsetData || typeof problemsetData !== 'object') {
                return;
            }

            for (const value of Object.values(problemsetData)) {
                if (!Array.isArray(value)) {
                    continue;
                }
                for (const entry of value) {
                    if (!entry || typeof entry !== 'object') {
                        continue;
                    }
                    const problemRecord = entry as { problem_id?: number | string; [key: string]: unknown };
                    const entryId = Number(problemRecord.problem_id);
                    if (!Number.isFinite(entryId) || entryId !== numericId) {
                        continue;
                    }
                    problemRecord.is_accepted = accepted;
                }
            }
        });
    }

    private async runSampleTest(
        language: string,
        filePath: string,
        sampleInput: string,
        expectedOutput?: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null; matched?: boolean }> {
        switch (language) {
            case 'python':
                return this.runPythonSample(filePath, sampleInput, expectedOutput);
            case 'java':
                return this.runJavaSample(filePath, sampleInput, expectedOutput);
            default:
                throw new Error(`暂未支持 ${language} 语言的快速测试`);
        }
    }

    private async runPythonSample(
        filePath: string,
        sampleInput: string,
        expectedOutput?: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null; matched?: boolean }> {
        const pythonPath = vscode.workspace.getConfiguration('ojAssistant').get<string>('pythonPath', 'python');
        const result = await this.runProcess(pythonPath, [filePath], sampleInput, path.dirname(filePath));
        const normalizedStdout = this.normalizeProgramOutput(result.stdout);
        const normalizedExpected = expectedOutput === undefined ? undefined : this.normalizeProgramOutput(expectedOutput);
        const matched = normalizedExpected !== undefined ? normalizedStdout === normalizedExpected : undefined;
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            matched,
        };
    }

    private async runJavaSample(
        filePath: string,
        sampleInput: string,
        expectedOutput?: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null; matched?: boolean }> {
        const { java, javac } = this.getJavaExecutables();
        const entryPoint = await this.detectJavaEntryPoint(filePath);
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oj-assistant-java-'));
        try {
            const compileArgs = ['-encoding', 'UTF-8', '-d', tempDir, filePath];
            const compileResult = await this.runProcess(javac, compileArgs, '', path.dirname(filePath));
            if (compileResult.exitCode !== 0) {
                const message = (compileResult.stderr || compileResult.stdout || '').trim() || '未知的编译错误';
                throw new Error(`Java 编译失败：\n${message}`);
            }

            const className = entryPoint.packageName ? `${entryPoint.packageName}.${entryPoint.mainClass}` : entryPoint.mainClass;
            const runArgs = ['-cp', tempDir, className];
            const runResult = await this.runProcess(java, runArgs, sampleInput, path.dirname(filePath));
            const normalizedStdout = this.normalizeProgramOutput(runResult.stdout);
            const normalizedExpected = expectedOutput === undefined ? undefined : this.normalizeProgramOutput(expectedOutput);
            const matched = normalizedExpected !== undefined ? normalizedStdout === normalizedExpected : undefined;
            return {
                stdout: runResult.stdout,
                stderr: runResult.stderr,
                exitCode: runResult.exitCode,
                matched,
            };
        } finally {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch {
                // ignore cleanup failures
            }
        }
    }

    private async detectJavaEntryPoint(filePath: string): Promise<{ mainClass: string; packageName: string | null }> {
        const content = await fs.readFile(filePath, 'utf8');
        const packageMatch = content.match(/^[\s\uFEFF\u200B]*package\s+([A-Za-z0-9_.]+)\s*;/m);
        const classMatch = content.match(/public\s+class\s+([A-Za-z0-9_]+)/);
        if (!classMatch) {
            throw new Error('无法识别 Java 主类，请确保存在 public class 定义');
        }
        const hasMainMethod = /public\s+static\s+void\s+main\s*\(/.test(content);
        if (!hasMainMethod) {
            throw new Error('未找到 public static void main(String[] args) 入口方法');
        }
        return {
            mainClass: classMatch[1],
            packageName: packageMatch ? packageMatch[1] : null,
        };
    }

    private getJavaExecutables(): { java: string; javac: string } {
        const config = vscode.workspace.getConfiguration('ojAssistant');
        const configuredJava = config.get<string>('javaPath')?.trim();
        const configuredJavac = config.get<string>('javacPath')?.trim();
        const suffix = process.platform === 'win32' ? '.exe' : '';
        const fromHome = (home: string | undefined, binary: string) =>
            home ? path.join(home, 'bin', `${binary}${suffix}`) : undefined;

        const pickFirst = (candidates: Array<string | undefined>): string => {
            for (const candidate of candidates) {
                if (candidate && candidate.trim()) {
                    return candidate;
                }
            }
            return '';
        };

        const javaBinary = pickFirst([
            configuredJava,
            fromHome(process.env.JAVA_HOME, 'java'),
            fromHome(process.env.JDK_HOME, 'java'),
            suffix ? `java${suffix}` : undefined,
            'java',
        ]) || 'java';

        const javacBinary = pickFirst([
            configuredJavac,
            fromHome(process.env.JAVA_HOME, 'javac'),
            fromHome(process.env.JDK_HOME, 'javac'),
            suffix ? `javac${suffix}` : undefined,
            'javac',
        ]) || 'javac';

        return { java: javaBinary, javac: javacBinary };
    }

    private async runProcess(
        command: string,
        args: readonly string[],
        input: string,
        cwd: string,
    ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, [...args], {
                cwd,
                shell: false,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data: Buffer) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            child.on('error', (error) => {
                reject(error);
            });

            child.on('close', (code) => {
                resolve({ stdout, stderr, exitCode: code });
            });

            if (input) {
                const normalizedInput = input.endsWith('\n') ? input : `${input}\n`;
                child.stdin.write(normalizedInput);
            }
            child.stdin.end();
        });
    }

    private normalizeProgramOutput(value: string): string {
        return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
    }

    private async persistPreferredLanguage(language: string): Promise<void> {
        const normalized = this.normalizeLanguage(language);
        this.preferredLanguage = normalized;
        await this.mutatePersistedSession((persisted) => {
            persisted.preferredLanguage = normalized;
        });
    }

    private postMessage(message: Record<string, unknown>): void {
        this.view?.webview.postMessage(message);
    }

    private async ensureSession(): Promise<SessionState> {
        if (this.session) {
            return this.session;
        }
        if (!this.sessionRestorePromise) {
            this.sessionRestorePromise = this.tryRestoreSession();
        }
        await this.sessionRestorePromise;
        if (!this.session) {
            throw new Error('请先登录在线评测系统');
        }
        return this.session;
    }

    private async handleSelectProblem(problemId: number | null): Promise<void> {
        this.currentProblemId = typeof problemId === 'number' ? problemId : null;
        if (!this.session) {
            return;
        }
        await this.updatePersistedCurrentProblem(problemId);
    }

    private getStateDirUri(): vscode.Uri | undefined {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return undefined;
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, this.stateDirName);
    }

    private getStateFileUri(): vscode.Uri | undefined {
        const dirUri = this.getStateDirUri();
        if (!dirUri) {
            return undefined;
        }
        return vscode.Uri.joinPath(dirUri, this.stateFileName);
    }

    private async ensureStateDirectory(): Promise<vscode.Uri | undefined> {
        const dirUri = this.getStateDirUri();
        if (!dirUri) {
            return undefined;
        }
        await this.ensureDirectory(dirUri);
        return dirUri;
    }

    private async readPersistedSession(): Promise<PersistedSession | undefined> {
        const fileUri = this.getStateFileUri();
        if (!fileUri) {
            return undefined;
        }
        const exists = await this.fileExists(fileUri);
        if (!exists) {
            return undefined;
        }
        try {
            const raw = await vscode.workspace.fs.readFile(fileUri);
            const text = Buffer.from(raw).toString('utf8');
            return JSON.parse(text) as PersistedSession;
        } catch (error) {
            await this.deletePersistedSession();
            void vscode.window.showWarningMessage(`无法读取持久化登录信息，已清除：${(error as Error).message}`);
            return undefined;
        }
    }

    private async writePersistedSession(session: PersistedSession): Promise<void> {
        const fileUri = this.getStateFileUri();
        if (!fileUri) {
            if (!this.warnedMissingWorkspace) {
                this.warnedMissingWorkspace = true;
                void vscode.window.showWarningMessage('未检测到工作区，无法将登录状态写入文件。');
            }
            return;
        }
        this.warnedMissingWorkspace = false;
        const dirUri = await this.ensureStateDirectory();
        if (!dirUri) {
            return;
        }
        const snapshot: PersistedSession = { ...session };
        if (!snapshot.rememberPassword) {
            delete snapshot.passwordHash;
        }
        const payload = JSON.stringify(snapshot, null, 2);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(`${payload}
`, 'utf8'));
    }

    private async deletePersistedSession(): Promise<void> {
        const fileUri = this.getStateFileUri();
        if (!fileUri) {
            return;
        }
        try {
            await vscode.workspace.fs.delete(fileUri);
        } catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') {
                return;
            }
            throw error;
        }
    }

    private async recordLogin(
        userId: string,
        rememberPassword: boolean,
        passwordHash: string | undefined,
        options?: { clearCachedData?: boolean },
    ): Promise<void> {
        this.savedCredentials = { userId, passwordHash, rememberPassword };
        const clearCachedData = options?.clearCachedData ?? false;
        await this.mutatePersistedSession((state) => {
            state.userId = userId;
            state.rememberPassword = rememberPassword;
            if (rememberPassword && passwordHash) {
                state.passwordHash = passwordHash;
            } else {
                delete state.passwordHash;
            }
            if (clearCachedData) {
                delete state.problemset;
                delete state.lastProblem;
                delete state.currentProblemId;
            }
        });
    }

    private async mutatePersistedSession(mutator: (session: PersistedSession) => void): Promise<void> {
        let persisted = await this.readPersistedSession();
        if (!persisted) {
            persisted = {
                savedAt: Date.now(),
                userId: this.savedCredentials?.userId ?? this.session?.userId ?? '',
                rememberPassword: this.savedCredentials?.rememberPassword ?? false,
                preferredLanguage: this.preferredLanguage,
            };
            if (persisted.rememberPassword && this.savedCredentials?.passwordHash) {
                persisted.passwordHash = this.savedCredentials.passwordHash;
            }
        } else {
            if (this.savedCredentials) {
                persisted.userId = this.savedCredentials.userId;
                persisted.rememberPassword = this.savedCredentials.rememberPassword;
                if (this.savedCredentials.rememberPassword && this.savedCredentials.passwordHash) {
                    persisted.passwordHash = this.savedCredentials.passwordHash;
                } else {
                    delete persisted.passwordHash;
                }
            }
        }
        mutator(persisted);
        persisted.savedAt = Date.now();
        await this.writePersistedSession(persisted);
    }

    private hashPassword(secret: string): string {
        return crypto.createHash('md5').update(secret, 'utf8').digest('hex');
    }

    private hasSavedPassword(): boolean {
        return Boolean(this.savedCredentials?.passwordHash);
    }

    private async tryAutoLoginInternal(
        userId: string,
        passwordHash: string,
        options?: { clearCachedData?: boolean },
    ): Promise<boolean> {
        try {
            const data = await this.python.execute<{ cookies: Record<string, string> }>('login', {
                username: userId,
                password_hash: passwordHash,
            });
            this.session = { cookies: data.cookies, userId };
            if (!options?.clearCachedData) {
                this.currentProblemId = this.currentProblemId ?? null;
            }
            await this.recordLogin(userId, true, passwordHash, { clearCachedData: options?.clearCachedData ?? false });
            return true;
        } catch (error) {
            this.session = undefined;
            return false;
        }
    }

    private async tryAutoLogin(): Promise<boolean> {
        if (!this.savedCredentials?.rememberPassword || !this.savedCredentials.passwordHash) {
            return false;
        }
        if (!this.autoLoginPromise) {
            this.autoLoginPromise = (async () => {
                const success = await this.tryAutoLoginInternal(
                    this.savedCredentials!.userId,
                    this.savedCredentials!.passwordHash!,
                    { clearCachedData: false },
                );
                if (!success) {
                    await this.recordLogin(this.savedCredentials!.userId, false, undefined, { clearCachedData: false });
                }
                this.autoLoginPromise = undefined;
                return success;
            })();
        }
        return this.autoLoginPromise;
    }

    private shouldAttemptRelogin(error: unknown): boolean {
        if (!error) {
            return false;
        }
        const message = (error as Error).message ?? '';
        if (!message) {
            return false;
        }
        const normalized = message.toLowerCase();
        return normalized.includes('auth_required') || normalized.includes('重新登录') || normalized.includes('请先登录');
    }

    private async withAutoRelogin<T>(operation: () => Promise<T>): Promise<T> {
        try {
            return await operation();
        } catch (error) {
            if (this.shouldAttemptRelogin(error) && (await this.tryAutoLogin())) {
                return operation();
            }
            throw error;
        }
    }

    private async executeWithSession<T>(operation: (session: SessionState) => Promise<T>): Promise<T> {
        return this.withAutoRelogin(async () => {
            const session = await this.ensureSession();
            return operation(session);
        });
    }

    private async updatePersistedCurrentProblem(problemId: number | null): Promise<void> {
        await this.mutatePersistedSession((persisted) => {
            if (typeof problemId === 'number') {
                persisted.currentProblemId = problemId;
                if (persisted.lastProblem && persisted.lastProblem.problemId !== problemId) {
                    delete persisted.lastProblem;
                }
            } else {
                delete persisted.currentProblemId;
                delete persisted.lastProblem;
            }
        });
    }

    private async tryRestoreSession(): Promise<void> {
        if (this.session) {
            return;
        }
        const persisted = await this.readPersistedSession();
        if (!persisted) {
            return;
        }
        if (persisted.preferredLanguage) {
            this.preferredLanguage = this.normalizeLanguage(persisted.preferredLanguage);
        }
        const rememberPassword = Boolean(persisted.rememberPassword);
        const passwordHash = rememberPassword ? persisted.passwordHash : undefined;
        this.savedCredentials = {
            userId: persisted.userId,
            rememberPassword,
            passwordHash,
        };

        const cachedProblemId = typeof persisted.currentProblemId === 'number' ? persisted.currentProblemId : null;
        const cachedProblemset = persisted.problemset;
        const cachedProblem = persisted.lastProblem;

        if (rememberPassword && passwordHash) {
            const success = await this.tryAutoLoginInternal(persisted.userId, passwordHash, { clearCachedData: false });
            if (success && this.session) {
                this.currentProblemId = cachedProblemId;
                this.postMessage({
                    type: 'sessionRestored',
                    userId: persisted.userId,
                    rememberPassword: true,
                    currentProblemId: this.currentProblemId,
                    problemset: cachedProblemset,
                    lastProblem: cachedProblem,
                    hasSavedPassword: this.hasSavedPassword(),
                    preferredLanguage: this.preferredLanguage,
                });
                return;
            }
        }

        this.postMessage({
            type: 'savedCredentials',
            userId: persisted.userId,
            rememberPassword,
            hasSavedPassword: this.hasSavedPassword(),
            preferredLanguage: this.preferredLanguage,
        });
    }

    private renderHtml(webview: vscode.Webview): string {
        const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'dashboard.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'dashboard.css'));
        const nonce = this.createNonce();

        return `<!DOCTYPE html>
<html lang="zh-cn">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: http: data: ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${styleUri}">
    <title>OJ Productivity Assistant</title>
</head>
<body>
    <header>
        <h1>OJ Productivity Assistant</h1>
        <p>连接 2024.jdoj.tech，提升刷题效率。</p>
    </header>
    <main>
        <section class="card collapsible-card" id="login-card">
            <details id="login-panel" open>
                <summary id="login-summary">登录账号（点击展开）</summary>
                <form id="login-form">
                    <label>用户名
                        <input type="text" name="username" required>
                    </label>
                    <label>密码
                        <input type="password" name="password" required>
                    </label>
                    <label class="remember-toggle">
                        <span>
                            <input type="checkbox" name="remember" checked>
                            记住密码
                        </span>
                    </label>
                    <button type="submit">登录</button>
                    <button type="button" id="use-saved-password" class="secondary-button hidden">使用已保存的密码</button>
                </form>
                <div class="status" id="login-status"></div>
            </details>
        </section>
        <section class="card" id="problemset">
            <h2>题目列表</h2>
            <form id="problemset-form">
                <div class="form-row">
                    <label>起始页
                        <input type="number" name="startPage" min="1" value="1">
                    </label>
                    <label>最大页数
                        <input type="number" name="maxPages" min="1" placeholder="留空表示只获取一页">
                    </label>
                    <button type="submit">获取题单</button>
                </div>
            </form>
            <div class="table-container">
                <table id="problemset-table">
                    <thead>
                        <tr>
                            <th>编号</th>
                            <th>标题</th>
                            <th>通过/提交</th>
                            <th>通过率</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="4" class="placeholder">登录并点击“获取题单”加载数据</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
        <section class="card" id="problem-detail">
            <div class="problem-toolbar hidden" id="problem-toolbar">
                <button type="button" id="toolbar-open-file">打开代码文件</button>
            </div>
            <div id="problem-output" class="problem-content">
                <div class="placeholder">在题目列表中选择一题查看详情</div>
            </div>
            <div id="problem-actions" class="hidden">
                <div class="action-block">
                    <h3>代码文件</h3>
                    <form id="detail-file-form" class="inline-form">
                        <label>语言
                            <select name="language" id="language-select"></select>
                        </label>
                        <button type="submit">创建/打开代码文件</button>
                    </form>
                    <div class="status" id="file-status"></div>
                </div>
                <div class="action-block">
                    <h3>提交评测</h3>
                    <form id="detail-submit-form" class="inline-form">
                        <label>代码文件路径
                            <input type="text" name="filePath" placeholder="相对或绝对路径" required>
                        </label>
                        <button type="submit">提交代码</button>
                    </form>
                </div>
                <div class="action-block" id="sample-test-block">
                    <h3>样例测试</h3>
                    <button type="button" id="sample-test-button">使用样例快速测试</button>
                    <div class="status" id="sample-test-status"></div>
                    <pre class="output hidden" id="sample-test-output"></pre>
                </div>
            </div>
            <div class="output submission-output" id="submission-output"></div>
            <div class="problem-navigation hidden" id="problem-navigation">
                <button type="button" id="nav-prev-button">上一题</button>
                <button type="button" id="nav-next-button">下一题</button>
            </div>
        </section>
        <section class="card" id="status">
            <h2>提交记录</h2>
            <form id="status-form">
                <div class="form-row">
                    <label>记录条数
                        <input type="number" name="limit" min="1" value="10">
                    </label>
                    <button type="submit">刷新</button>
                </div>
            </form>
            <div class="table-container">
                <table id="status-table">
                    <thead>
                        <tr>
                            <th>编号</th>
                            <th>题目</th>
                            <th>结果</th>
                            <th>耗时</th>
                            <th>内存</th>
                            <th>语言</th>
                            <th>提交时间</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td colspan="7" class="placeholder">登录后可刷新提交记录</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    private createNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        return Array.from({ length: 32 }, () => possible[Math.floor(Math.random() * possible.length)]).join('');
    }

    private async ensureDirectory(uri: vscode.Uri): Promise<void> {
        try {
            await vscode.workspace.fs.stat(uri);
        } catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') {
                await vscode.workspace.fs.createDirectory(uri);
                return;
            }
            throw error;
        }
    }

    private async fileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') {
                return false;
            }
            throw error;
        }
    }

    private getExtensionForLanguage(language: string): string {
        switch (language) {
            case 'python':
                return 'py';
            case 'cpp':
                return 'cpp';
            case 'java':
                return 'java';
            default:
                return 'txt';
        }
    }

    private normalizeLanguage(language: string): string {
        switch (language) {
            case 'python':
            case 'cpp':
            case 'java':
                return language;
            default:
                return 'python';
        }
    }

    private getTemplateForLanguage(language: string, problemId: number): string {
        const newline = '\n';
        const indentUnit = this.getIndentUnit(language);
        const indent = (level: number) => indentUnit.repeat(level);
        const header = this.getHeaderForLanguage(language, problemId);

        switch (language) {
            case 'python':
                return [
                    header,
                    'def solve():',
                    `${indent(1)}pass`,
                    '',
                    'if __name__ == "__main__":',
                    `${indent(1)}solve()`,
                    '',
                ].join(newline);
            case 'cpp':
                return [
                    header,
                    '#include <bits/stdc++.h>',
                    'using namespace std;',
                    '',
                    'int main() {',
                    `${indent(1)}ios::sync_with_stdio(false);`,
                    `${indent(1)}cin.tie(nullptr);`,
                    '',
                    `${indent(1)}return 0;`,
                    '}',
                    '',
                ].join(newline);
            case 'java':
                return [
                    header,
                    'public class Main {',
                    `${indent(1)}public static void main(String[] args) throws Exception {`,
                    `${indent(1)}}`,
                    '}',
                    '',
                ].join(newline);
            default:
                return `${header}${newline}`;
        }
    }

    private getHeaderForLanguage(language: string, problemId: number): string {
        const prefix = language === 'python' ? '#' : '//';
        return `${prefix} Problem ${problemId}`;
    }

    private getIndentUnit(language: string): string {
        const languageId = this.mapLanguageToEditorId(language);
        const scope = languageId ? { languageId } : undefined;
        const editorConfig = vscode.workspace.getConfiguration('editor', scope);
        const insertSpaces = editorConfig.get<boolean>('insertSpaces');
        const tabSizeSetting = editorConfig.get<string | number>('tabSize');
        let tabSize = typeof tabSizeSetting === 'number' ? tabSizeSetting : Number.parseInt(`${tabSizeSetting ?? ''}`, 10);
        if (!Number.isFinite(tabSize) || tabSize <= 0) {
            tabSize = 4;
        }
        const useSpaces = insertSpaces ?? true;
        const normalizedTabSize = Math.max(1, Math.trunc(tabSize));
        return useSpaces ? ' '.repeat(normalizedTabSize) : '\t';
    }

    private mapLanguageToEditorId(language: string): string | undefined {
        switch (language) {
            case 'python':
                return 'python';
            case 'cpp':
                return 'cpp';
            case 'java':
                return 'java';
            default:
                return undefined;
        }
    }

    private getLanguageCode(language: string): number {
        switch (language) {
            case 'python':
                return 6;
            case 'java':
                return 3;
            case 'cpp':
                return 1;
            default:
                return 6;
        }
    }

    private resolveFileUri(filePath: string): vscode.Uri {
        if (path.isAbsolute(filePath)) {
            return vscode.Uri.file(filePath);
        }
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('请提供绝对路径或在工作区内使用相对路径');
        }
        return vscode.Uri.joinPath(workspaceFolder.uri, filePath);
    }
}
