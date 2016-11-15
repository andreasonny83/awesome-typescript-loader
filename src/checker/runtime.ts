import * as path from 'path';
import * as colors from 'colors';
import { findResultFor } from '../helpers';
import {
    Req,
    Res,
    LoaderConfig,
    CompilerInfo,
    Init,
    EmitFile,
    UpdateFile,
    Diagnostics,
    Files,
    MessageType,
    TsConfig
} from './protocol';

export interface File {
    text: string;
    version: number;
    snapshot: ts.IScriptSnapshot;
}

let projectVersion = 0;
let loaderConfig: LoaderConfig;
let compilerConfig: TsConfig;
let compilerOptions: ts.CompilerOptions;
let webpackOptions: any;
let compiler: typeof ts;
let compilerInfo: CompilerInfo;
let files: {[fileName: string]: File} = {};
let host: ts.LanguageServiceHost;
let service: ts.LanguageService;
let ignoreDiagnostics: {[id: number]: boolean} = {};

function ensureFile(fileName: string) {
    if (!files[fileName]) {
        const text = compiler.sys.readFile(fileName);
        if (text) {
            files[fileName] = {
                text,
                version: 0,
                snapshot: compiler.ScriptSnapshot.fromString(text)
            };
        }
    }
}

class FileDeps {
    files: {[fileName: string]: string[]} = {};

    add(containingFile: string, ...dep: string[]) {
        if (!this.files[containingFile]) {
            this.files[containingFile] = Array.from(dep);
        } else {
            const deps = this.files[containingFile];
            deps.push.apply(deps, dep);
        }
    }

    getDeps(containingFile: string): string[] {
        return this.files[containingFile] || [];
    }

    getAllDeps(containingFile: string, allDeps = new Set<string>(), initial = true): string[] {
        const deps = this.getDeps(containingFile);
        deps.forEach(dep => {
            if (!allDeps.has(dep)) {
                allDeps.add(dep);
                this.getAllDeps(dep, allDeps, false);
            }
        });

        if (initial) {
            return Array.from(allDeps.keys());
        }
    }
}

const fileDeps = new FileDeps();

class Host implements ts.LanguageServiceHost {
    getProjectVersion() { return projectVersion.toString(); }

    getScriptFileNames() {
        return Object.keys(files);
    }

    getScriptVersion(fileName: string) {
        ensureFile(fileName);
        if (files[fileName]) {
            return files[fileName].version.toString();
        }
    }

    getScriptSnapshot(fileName: string) {
        ensureFile(fileName);
        if (files[fileName]) {
            return files[fileName].snapshot;
        }
    }

    getCurrentDirectory() {
        return process.cwd();
    }

    getScriptIsOpen() {
        return true;
    }

    getCompilationSettings() {
        return compilerOptions;
    }

    resolveTypeReferenceDirectives(typeDirectiveNames: string[], containingFile: string) {
        const resolved = typeDirectiveNames.map(directive =>
            compiler.resolveTypeReferenceDirective(directive, containingFile, compilerOptions, compiler.sys)
                .resolvedTypeReferenceDirective);

        resolved.forEach(res => {
            if (res && res.resolvedFileName) {
                fileDeps.add(containingFile, res.resolvedFileName);
            }
        });

        return resolved;
    }

    resolveModuleNames(moduleNames: string[], containingFile: string) {
        const resolved =  moduleNames.map(module =>
            compiler.resolveModuleName(module, containingFile, compilerOptions, compiler.sys).resolvedModule);

        resolved.forEach(res => {
            if (res && res.resolvedFileName) {
                fileDeps.add(containingFile, res.resolvedFileName);
            }
        });

        return resolved;
    }

    log(message) {
        console.log(message);
    }

    fileExists(...args) {
        return compiler.sys.fileExists.apply(compiler.sys, args);
    }

    readFile(...args) {
        return compiler.sys.readFile.apply(compiler.sys, args);
    }

    readDirectory(...args) {
        return compiler.sys.readDirectory.apply(compiler.sys, args);
    }

    getDefaultLibFileName(options: ts.CompilerOptions) {
       return compiler.getDefaultLibFilePath(options);
    }

    useCaseSensitiveFileNames() {
        return compiler.sys.useCaseSensitiveFileNames;
    }

    getDirectories(...args) {
        return compiler.sys.getDirectories.apply(compiler.sys, args);
    }

    directoryExists(path: string) {
        return compiler.sys.directoryExists(path);
    }
}

function processInit({seq, payload}: Init.Request) {
    compiler = require(payload.compilerInfo.compilerPath);
    compilerInfo = payload.compilerInfo;
    loaderConfig = payload.loaderConfig;
    compilerConfig = payload.compilerConfig;
    compilerOptions = compilerConfig.options;
    webpackOptions = payload.webpackOptions;

    host = new Host();
    service = compiler.createLanguageService(new Host());

    compilerConfig.fileNames.forEach(fileName => {
        const text = compiler.sys.readFile(fileName);
        files[fileName] = {
            text,
            version: 0,
            snapshot: compiler.ScriptSnapshot.fromString(text)
        };
    });

    const program = service.getProgram();
    program.getSourceFiles().forEach(file => {
        files[file.fileName] = {
            text: file.text,
            version: 0,
            snapshot: compiler.ScriptSnapshot.fromString(file.text)
        };
    });

    if (loaderConfig.ignoreDiagnostics) {
        loaderConfig.ignoreDiagnostics.forEach(diag => {
            ignoreDiagnostics[diag] = true;
        });
    }

    replyOk(seq, null);
}

function updateFile(fileName: string, text: string) {
    const file = files[fileName];
    if (file) {
        if (file.text !== text) {
            projectVersion++;
            file.version++;
            file.snapshot = compiler.ScriptSnapshot.fromString(text);
        }
    } else {
        projectVersion++;
        files[fileName] = {
            text,
            version: 0,
            snapshot: compiler.ScriptSnapshot.fromString(text)
        };
    }
}

function emit(fileName: string) {
    if (loaderConfig.useTranspileModule || loaderConfig.transpileOnly) {
        return fastEmit(fileName);
    } else {
        const output = service.getEmitOutput(fileName, false);
        if (output.outputFiles.length > 0) {
            return findResultFor(fileName, output);
        } else {
            return fastEmit(fileName);
        }
    }
}

function fastEmit(fileName: string) {
    const trans = compiler.transpileModule(files[fileName].text, {
        compilerOptions: compilerOptions,
        fileName,
        reportDiagnostics: false
    });

    return {
        text: trans.outputText,
        sourceMap: trans.sourceMapText
    };
}

function processUpdate({seq, payload}: UpdateFile.Request) {
    updateFile(payload.fileName, payload.text);
    replyOk(seq, null);
}

function processEmit({seq, payload}: EmitFile.Request) {
    updateFile(payload.fileName, payload.text);
    const emitResult = emit(payload.fileName);
    const deps = fileDeps.getAllDeps(payload.fileName);

    replyOk(seq, {emitResult, deps});
}

function processFiles({seq}: Files.Request) {
    replyOk(seq, {
        files: service.getProgram().getSourceFiles().map(f => f.fileName)
    });
}

function processDiagnostics({seq}: Diagnostics.Request) {
    let instanceName = loaderConfig.instance || 'at-loader';
    let silent = !!loaderConfig.forkCheckerSilent;

    const timeStart = +new Date();

    if (!silent) {
        console.log(colors.cyan(`\n[${ instanceName }] Checking started in a separate process...`));
    }

    const allDiagnostics = service.getProgram().getOptionsDiagnostics().concat(
        service.getProgram().getGlobalDiagnostics(),
        service.getProgram().getSyntacticDiagnostics(),
        service.getProgram().getSemanticDiagnostics(),
    );

    if (allDiagnostics.length) {
        console.error(colors.red(`\n[${ instanceName }] Checking finished with ${ allDiagnostics.length } errors`));
    } else {
        if (!silent) {
            let timeEnd = +new Date();
            console.log(
                colors.green(`\n[${ instanceName }] Ok, ${(timeEnd - timeStart) / 1000} sec.`)
            );
        }
    }

    const processedDiagnostics = allDiagnostics
        .filter(diag => !ignoreDiagnostics[diag.code])
        .map(diagnostic => {
            const message = compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            const fileName = diagnostic.file && path.relative(process.cwd(), diagnostic.file.fileName);
            let pretty = '';
            let line = 0;
            let character = 0;

            if (diagnostic.file) {
                const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                line = pos.line;
                character = pos.character;
                pretty = (`[${ instanceName }] ${colors.red(fileName)}:${line + 1}:${character + 1} \n    ${colors.red(message)}`);
            } else {
                pretty = (colors.red(`[${ instanceName }] ${ message }`));
            }

            return {
                category: diagnostic.category,
                code: diagnostic.code,
                fileName,
                start: diagnostic.start,
                message,
                pretty,
                line,
                character
            };
        });

    replyOk(seq, processedDiagnostics);
}


function replyOk(seq: number, payload: any) {
    process.send({
        seq,
        success: true,
        payload
    } as Res);
}

function replyErr(seq: number, payload: any) {
    process.send({
        seq,
        success: false,
        payload
    } as Res);
}

process.on('message', function(req: Req) {
    switch (req.type) {
        case MessageType.Init:
            processInit(req);
            break;
        case MessageType.UpdateFile:
            processUpdate(req);
            break;
        case MessageType.EmitFile:
            processEmit(req);
            break;
        case MessageType.Diagnostics:
            processDiagnostics(req);
            break;
        case MessageType.Files:
            processFiles(req);
            break;
    }
});