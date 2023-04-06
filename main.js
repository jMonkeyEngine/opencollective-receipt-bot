

import Imaps from 'imap-simple';
import MailParser from 'mailparser';
import fetch from 'node-fetch';
import Fs from 'fs/promises';
import _ from 'lodash';
import FormData from 'form-data';
import TelegramBot from 'node-telegram-bot-api';

async function parseMessage(message) {
    const out = {};

    let all = _.find(message.parts, { "which": "" })

    const id = message.attributes.uid;
    const idHeader = "Imap-Id: " + id + "\r\n";

    const parsedBody = await MailParser.simpleParser(idHeader + all.body, {
        skipImageLinks: true,
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipTextLinks: true
    });
    out.subject = parsedBody.subject;
    out.from = parsedBody.from.text;

    out.files = [];
    for (let i in parsedBody.attachments) {
        out.files.push(
            {
                attachment: parsedBody.attachments[i].content,
                name: parsedBody.attachments[i].filename
            }
        );
    }

    return out;
}


async function getMailedReceipts(Config) {
    const receipts = [];
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    const config = {
        imap: {
            user: Config.imapUser,
            password: Config.imapPassword,
            host: Config.imapHost,
            port: Config.imapPort,
            tls: true,
            authTimeout: 3000
        },
    };
    const connection = await Imaps.connect(config);
    await connection.openBox("INBOX");

    let since = new Date();
    since.setTime(Date.now() - (60 * 24 * 3600 * 1000)); //2 months
    since = since.toISOString();
    const searchCriteria = ['ALL', ['SINCE', since]];

    const fetchOptions = {
        bodies: ['HEADER.FIELDS (SUBJECT FROM)', 'TEXT', ''],
        markSeen: false
    };
    const messages = await connection.search(searchCriteria, fetchOptions);

    for (let message of messages) {
        message = await parseMessage(message);
        if (Config.receiptEmitters.indexOf(message.from.trim()) == -1) continue;
        if (message.subject.startsWith(Config.mailPrefix)) {
            for (let file of message.files) {
                if (!file.name.startsWith(Config.receiptPrefix)) continue;
                receipts.push({
                    name: file.name,
                    data: file.attachment
                });
            }
        }
    }
    connection.end();
    return receipts;
}

async function healthReport(config, v,log,ping=0){
    if(!log)log=v?"OK":"FAIL";
    const status=v?"up":"down";
    const url=`${config.healthMonitor}/api/push/${config.healthMonitorKey}?status=${status}&msg=${log}&ping=${ping}`
    await fetch(url);
}


async function main() {
    const config = JSON.parse(await Fs.readFile("./config.json"));
    const bot = config.telegramBotToken ? new TelegramBot(config.telegramBotToken, { polling: false }) : undefined;
    const botChatId = config.telegramBotChatID;

    let logs = "";
    const log = (tx) => {
        console.log(tx);
        logs += tx+"\n";
    };
    const submitError = () => {
        if (logs == "") return;
        console.error(logs);
        if (bot) bot.sendMessage(botChatId, logs);
        logs = "";
    };
    const submitInfo = () => {
        if (logs == "") return;
        console.info(logs);
        if (bot) bot.sendMessage(botChatId, logs);
        logs = "";
    };
    const resetLog = () => {
        logs = "";
    };
    // log("Started!");
    // submitInfo();
    loop(config, log, submitInfo, submitError, resetLog);
}


let ERRORS=0;
async function loop(config, log, submitInfo, submitError, resetLog) {
    try {
        if (await checkAndSubmit(config, log)) {
            submitInfo();
            console.log("New receipt found.")
            healthReport(config,true,"New receipt found");
        } else {
            resetLog();
            console.log("No new receipt found. Sleep for a while.");
            healthReport(config,true,"No new receipt found");
        }       
        ERRORS=0;
    } catch (eeeee) {
        console.error(eeeee)
        log("" + eeeee);
        healthReport(config,false,eeeee.message)
        ERRORS++;
        if(ERRORS>=config.numErrorsToTriggerSubmission){
            submitError();
            ERRORS=0;
        }else{
            resetLog();
        }
    }
    setTimeout(()=>loop(config,log,submitInfo,submitError,resetLog), config.checkInterval * 1000);
}


async function checkAndSubmit(config, log) {
    log("Check for new receipt.");
    const OC_QUERY = `
        query expenses {
            expenses(account: {slug: "${config.collective}"}) {
                nodes{
                    id
                    status
                    tags
                    requiredLegalDocuments
                    description
                    createdAt
                    virtualCard {
                        name
                        id
                    }
                    items{
                        description
                        amount
                        createdAt
                        incurredAt
                        id
                        url
                    }      
                }
            }
        }
    `;
           

    // Find expenses
    let resp = await fetch(config.openCollectiveApiEndPoint + "/" + config.openCollectiveApiKey, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            query: OC_QUERY
        })
    }).then((res) => res.json());

    const expenses = resp.data.expenses.nodes.filter(ex => {
        return ex.virtualCard&&(
            config.virtualCards.includes(ex.virtualCard.name)
            ||config.virtualCards.includes(ex.virtualCard.id)
        );
    }); // new -> old


    // Find last submitted receipt
    let lastReceiptName;
    for (const expense of expenses) {
        if (expense.items[0].description) {
            lastReceiptName = expense.items[0].description;
            break;
        }
    }

    if (!lastReceiptName) return false;
    log("Last receipt " + lastReceiptName);


    // Find unsent receipts from mail account
    let unsentReceipts = []; // old -> new
    const mailedReceipts = await getMailedReceipts(config);
    if(mailedReceipts.length==1&&mailedReceipts[0].name != lastReceiptName){
        unsentReceipts.push(mailedReceipts[0]);
    }else{
        for (let i = mailedReceipts.length - 2; i >= 0; i--) {
            const mailedReceipt = mailedReceipts[i];
            if (mailedReceipt.name == lastReceiptName) {
                unsentReceipts = mailedReceipts.slice(i + 1);
                break;
            }
        }
    }
    if (unsentReceipts.length == 0) return false;

    // Submit receipts
    let submit=false;
    let receiptI = unsentReceipts.length - 1;
    for (const expense of expenses) {
        if (!expense.items[0].description) {
            if (receiptI < 0) break;
            const receipt = unsentReceipts[receiptI];
            log("Send " + receipt.name + " to expense " + expense.id + " " + expense.description + " " + expense.createdAt);

            const bodyData = new FormData()
            bodyData.append("file", receipt.data, receipt.name);
            bodyData.append("kind", "EXPENSE_ATTACHED_FILE");

            const fileUrl = await fetch(config.openCollectiveUploadEndPoint, {
                body: bodyData,
                headers: {
                    "Accept": "*/*",
                    "Accept-Encoding": "gzip, deflate, br",
                    "Accept-Language": "en-US,en;q=0.5",
                    "Cache-Control": "no-cache",
                    "Origin": config.openCollectiveOrigin,
                    "Pragma": "no-cache",
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "same-origin",
                    "Api-Key": config.openCollectiveApiKey,
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:97.0) Gecko/20100101 Firefox/97.0"
                },
                method: "POST"
            }).then(res => res.text()).then(rest => {
                let res;
                try {
                    res = JSON.parse(rest);
                } catch (e) {
                    throw new Error("Can't parse " + rest + " " + e);
                }
                if (res.status != 200) throw new Error("Error " + JSON.stringify(res));
                return res.url;

            });
            log("File uploaded " + fileUrl);

            const mutation = `mutation EditExpense($expense: ExpenseUpdateInput!) {
                        editExpense(expense: $expense) {
                        id
                        tags
                        items{
                            amount
                            id
                            description
                            url
                        }
                        }
                    }`

            const mutationData = {
                "expense": {
                    "id": expense.id,
                    "tags": config.tags,
                    "items": [
                        {
                            "id": expense.items[0].id,
                            "amount": expense.items[0].amount,
                            "description": receipt.name,
                            "url": fileUrl
                        }
                    ]
                }
            }
            log(JSON.stringify(mutationData));

            resp = await fetch(config.openCollectiveApiEndPoint + "/" + config.openCollectiveApiKey, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                },
                body: JSON.stringify({
                    query: mutation,
                    variables: mutationData
                })
            }).then((res) => res.json());
            log(JSON.stringify(resp));
            submit=true;
            receiptI--;
        }
    }

    return submit;
}



main();