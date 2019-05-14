import { CommanderStatic } from "commander";
import { log } from "console";
import * as fs from "fs";
import * as path from "path";
import { MindConnectAgent, retry } from "../..";
import { MindSphereSdk } from "../../api/sdk";
import { checkCertificate, decrypt, getHomeDotMcDir, loadAuth } from "../../api/utils";
import { errorLog, getColor, homeDirLog, proxyLog, retrylog, verboseLog } from "./command-utils";
import ora = require("ora");
const mime = require("mime-types");

let color = getColor("cyan");
const adminColor = getColor("magenta");

export default (program: CommanderStatic) => {
    program
        .command("upload-file")
        .alias("uf")
        .option("-c, --config <agentconfig>", "config file with agent configuration", "agentconfig.json")
        .option(
            "-r, --cert [privatekey]",
            "required for agents with RSA_3072 profile. create with: openssl genrsa -out private.key 3072"
        )
        .option("-f, --file <fileToUpload>", "file to upload to the file service")
        .option("-h, --filepath <filepath>", "file path in the mindsphere")
        .option("-l, --parallel <number>", "parallel chunk uploads", 3)
        .option("-i, --assetid [assetid]", "asset id from the mindsphere  (default: upload to the agent)")
        .option("-m, --mime [mime-type]", "mime type of the file (default: automatic recognition)")
        .option("-d, --desc [description]", "description")
        .option("-k, --chunked", "Use chunked upload")
        .option("-y, --retry <number>", "retry attempts before giving up", 3)
        .option(
            "-p, --passkey <passkey>",
            `passkey (optional, file upload uses ${adminColor("service credentials *")})`
        )
        .option("-v, --verbose", "verbose output")
        .description(
            `${color("upload the file to the mindsphere file service")} ${adminColor("(optional: passkey) *")}`
        )
        .action(options => {
            (async () => {
                try {
                    color = options.passkey ? adminColor : color;
                    checkParameters(options);
                    homeDirLog(options.verbose);
                    proxyLog(options.verbose);

                    const spinner = ora("uploadingFile");
                    !options.verbose && spinner.start();

                    const uploadFile = path.resolve(options.file);
                    verboseLog(`File to upload: ${color(uploadFile)}.`, options.verbose, spinner);

                    if (!fs.existsSync(uploadFile)) {
                        throw new Error(`Can't find file ${uploadFile}`);
                    }

                    let uploader;
                    let assetid = options.assetid;
                    const chunked = options.chunked ? true : false;

                    if (options.passkey === undefined) {
                        ({ assetid, uploader } = await getMindConnectAgent(assetid, options, spinner, color));
                    } else {
                        uploader = getIotFileUploader(options);
                    }

                    const mimeType = options.mime || mime.lookup(uploadFile) || "application/octet-stream";
                    const description =
                        options.desc || `File uploaded on ${new Date().toUTCString()} using mindconnect CLI`;

                    if (!fs.existsSync(uploadFile)) {
                        throw new Error(`Can't find file ${uploadFile}`);
                    }

                    verboseLog(
                        `Uploading the file: ${color(uploadFile)} with mime type ${mimeType}.`,
                        options.verbose,
                        spinner
                    );
                    verboseLog(`Description ${description}`, options.verbose, spinner);
                    verboseLog(`AssetId ${assetid}`, options.verbose, spinner);
                    verboseLog(
                        options.assetid === undefined ? "Uploading to agent." : "Uploading to another asset.",
                        options.verbose,
                        spinner
                    );
                    verboseLog(chunked ? `Using chunked upload` : `No chunked upload`, options.verbose, spinner);

                    const startDate = new Date();

                    const filePath = options.filepath ? options.filepath : path.basename(uploadFile);

                    const result = await uploader.UploadFile(assetid, filePath, uploadFile, {
                        description: description,
                        chunk: chunked,
                        retry: options.retry,
                        type: mimeType,
                        parallelUploads: options.parallel,
                        logFunction: (p: string) => {
                            return retrylog(p, color);
                        },
                        verboseFunction: (p: string) => {
                            verboseLog(p, options.verbose, spinner);
                        }
                    });

                    const endDate = new Date();

                    !options.verbose && spinner.succeed("Done");

                    log(`Upload time: ${(endDate.getTime() - startDate.getTime()) / 1000} seconds`);
                    log(`\nYour file ${color(uploadFile)} with ${result} md5 hash was succesfully uploaded.\n`);
                } catch (err) {
                    errorLog(err, options.verbose);
                }
            })();
        })
        .on("--help", () => {
            log("\n  Examples:\n");
            log(`    mc uf -f CHANGELOG.md   \t\t\t\t\t\t\t upload file CHANGELOG.md to the agent`);
            log(
                `    mc upload-file --file  CHANGELOG.md  --assetid 5...f --mime text/plain \t upload file to a specified asset with custom mime type`
            );
            log(
                `    mc upload-file --file  CHANGELOG.md  --chunked \t\t\t\t upload file using experimental chunked upload`
            );
        });
};
function getIotFileUploader(options: any) {
    const auth = loadAuth();
    const sdk = new MindSphereSdk({
        tenant: auth.tenant,
        basicAuth: decrypt(auth, options.passkey),
        gateway: auth.gateway
    });
    const uploader = sdk.GetIoTFileClient();
    return uploader;
}

export async function getMindConnectAgent(assetid: any, options: any, spinner: any, color: Function) {
    const configFile = path.resolve(options.config);
    verboseLog(`Upload using the agent configuration stored in: ${color(configFile)}.`, options.verbose, spinner);

    if (!fs.existsSync(configFile)) {
        throw new Error(`Can't find file ${configFile}`);
    }

    const configuration = require(configFile);
    const profile = checkCertificate(configuration, options);

    const agent = new MindConnectAgent(configuration, undefined, getHomeDotMcDir());
    if (profile) {
        agent.SetupAgentCertificate(fs.readFileSync(options.cert));
    }
    if (!agent.IsOnBoarded()) {
        await retry(options.retry, () => agent.OnBoard(), 300, retrylog("OnBoard"));
        log(color(`Your agent with id ${agent.ClientId()} was succesfully onboarded.`));
    }
    assetid = options.assetid || agent.ClientId();
    return { assetid, uploader: agent };
}

function checkParameters(options: any) {
    !options.file &&
        errorLog("Missing file name for upload-file command. Run mc uf --help for full syntax and examples.", true);
    options.passkey &&
        !options.assetid &&
        errorLog(" You have to specify assetid when using service credential upload", true);
}
