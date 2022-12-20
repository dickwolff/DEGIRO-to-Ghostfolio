import { GhostfolioExport } from "../models/ghostfolioExport";
import * as fs from "fs";
import dayjs from "dayjs"
import customParseFormat from "dayjs/plugin/customParseFormat";
import fetch from "cross-fetch";
import { parse } from "csv-parse";
import { DeGiroRecord } from "../models/degiroRecord";
import { GhostfolioOrderType } from "../models/ghostfolioOrderType";

require("dotenv").config();

dayjs.extend(customParseFormat);

// Define import file path.
const inputFile = process.env.INPUT_FILE;

// Generic header mapping from the DEGIRO CSV export.
const csvHeaders = [
    "date",
    "time",
    "currencyDate",
    "product",
    "isin",
    "description",
    "fx",
    "currency",
    "amount",
    "col1", // Not relevant column.
    "col2", // Not relevant column.
    "orderId"];

// Read file contents of the CSV export.
const csvFile = fs.readFileSync(inputFile, "utf-8");

// Parse the CSV and convert to Ghostfolio import format.
parse(csvFile, {
    delimiter: ",",
    fromLine: 2,
    columns: csvHeaders,
    cast: (columnValue, context) => {

        // Custom mapping below.

        return columnValue;
    }
}, async (_, records: DeGiroRecord[]) => {

    let errorExport = false;

    console.log(`Read CSV file ${inputFile}. Start processing..`);
    const exportFile: GhostfolioExport = {
        meta: {
            date: new Date(),
            version: "v0"
        },
        activities: []
    }

    // Retrieve bearer token for authentication.
    const bearerResponse = await fetch(`${process.env.GHOSTFOLIO_API_URL}/api/v1/auth/anonymous/${process.env.GHOSTFOLIO_SECRET}`);
    const bearer = await bearerResponse.json();

    for (let idx = 0; idx < records.length; idx++) {
        const record = records[idx];

        console.log(`\tProcessing ${idx + 1} of ${records.length}`);
        const description = record.description.toLocaleLowerCase();

        // Skip some records which contains one of the words below.
        if (description === '' ||
            description.indexOf("ideal") > -1 ||
            description.indexOf("derden") > -1 ||
            description.indexOf("flatex") > -1 ||
            description.indexOf("cash sweep") > -1 ||
            description.indexOf("withdrawal") > -1) {
            continue;
        }

        // TODO: Is is possible to add currency? So VWRL.AS is retrieved for IE00B3RBWM25 instead of VWRL.L.

        // Retrieve YAHOO Finance ticker that corresponds to the ISIN from DEGIRO record.
        const tickerUrl = `${process.env.GHOSTFOLIO_API_URL}/api/v1/symbol/lookup?query=${record.isin}`;
        const tickerResponse = await fetch(tickerUrl, {
            method: "GET",
            headers: [["Authorization", `Bearer ${bearer.authToken}`]]
        });

        // Check if response was not unauthorized.
        if (tickerResponse.status === 401) {
            console.error("Ghostfolio access token is not valid!");
            errorExport = true;
            break;
        }

        const tickers = await tickerResponse.json();

        let orderType: GhostfolioOrderType;
        let fees, unitPrice, numberShares = 0;
        let marker = "";

        // Dividend tax references to the previous record. This is always a "dividend" record.
        if (description.indexOf("dividendbelasting") > -1) {

            // Retrieve the data from this record and place it on the previous processed record.
            // This record should not be added, so it will be skipped after retrieving the required info.

            // Get dividend tax.
            unitPrice = Math.abs(parseFloat(record.amount.replace(',', '.')));

            // Set record values.
            exportFile.activities[exportFile.activities.length - 1].fee = unitPrice;
            exportFile.activities[exportFile.activities.length - 1].currency = record.currency;
            exportFile.activities[exportFile.activities.length - 1].comment = "";

            continue;
        }

        // Retrieve relevant data for a dividend record.
        if (description.indexOf("dividend") > -1) {
            orderType = GhostfolioOrderType.dividend;
            unitPrice = Math.abs(parseFloat(record.amount.replace(',', '.')));
        }

        // Check for a Sale record.
        const verkoopMatch = description.match(/(verkoop ([\d]+))/);
        if (verkoopMatch) {

            // Get relevant data.
            orderType = GhostfolioOrderType.sell;
            numberShares = parseFloat(verkoopMatch[2]);
            unitPrice = Math.abs(parseFloat(record.amount.replace(',', '.')));

            // For a Sale record, the preceding records should be "debitering" and "creditering", in that order. This means the sale had a transaction fee associated.
            // However only the "debitering" record is of relevance for the transaction. So the "creditering" record can be deleted.
            if (exportFile.activities[exportFile.activities.length - 2].comment === "debitering") {

                exportFile.activities[exportFile.activities.length - 2].type = orderType;
                exportFile.activities[exportFile.activities.length - 2].symbol = tickers.items[0].symbol;
                exportFile.activities[exportFile.activities.length - 2].quantity = numberShares;
                exportFile.activities[exportFile.activities.length - 2].unitPrice = unitPrice;
                exportFile.activities[exportFile.activities.length - 2].currency = record.currency;
                exportFile.activities[exportFile.activities.length - 2].comment = "";

                // Remove the "creditering" record.
                exportFile.activities.splice(exportFile.activities.length - 1, 1);

                continue;
            }
        }

        // Check for a Buy record.
        const koopMatch = description.match(/(koop ([\d]+))/);
        if (koopMatch) {

            // Get relevant data.
            orderType = GhostfolioOrderType.buy;
            numberShares = parseFloat(koopMatch[2]);
            unitPrice = Math.abs(parseFloat(record.amount.replace(',', '.')));

            // For a Sale record, the preceding records should be "creditering" and "debitering", in that order. This means the buy had a transaction fee associated.
            // However only the "creditering" record is of relevance for the transaction. So the "debitering" record can be deleted.
            if (exportFile.activities[exportFile.activities.length - 2].comment === "creditering") {

                // Set the buy transaction data.
                exportFile.activities[exportFile.activities.length - 2].type = orderType;
                exportFile.activities[exportFile.activities.length - 2].symbol = tickers.items[0].symbol;
                exportFile.activities[exportFile.activities.length - 2].quantity = numberShares;
                exportFile.activities[exportFile.activities.length - 2].unitPrice = unitPrice;
                exportFile.activities[exportFile.activities.length - 2].currency = record.currency;
                exportFile.activities[exportFile.activities.length - 2].comment = "";

                // Remove the "debitering" record.
                exportFile.activities.splice(exportFile.activities.length - 1, 1);

                continue;

            } else {

                // It is a buy transaction without fees (e.g. within Kernselectie).
                marker = "";
            }
        }

        // When ISIN is given, check for creditering/debitering records.
        // For this record the "FX" record should be retrieved. This contains the transaction fee in local currency.
        if (record.isin.length > 0) {

            const creditMatch = description.match(/(valuta creditering)/);
            if (creditMatch) {
                fees = Math.abs(parseFloat(record.fx.replace(',', '.')));
                marker = "creditering";
            }

            const debitMatch = description.match(/(valuta debitering)/);
            if (debitMatch) {
                fees = Math.abs(parseFloat(record.fx.replace(',', '.')));
                marker = "debitering";
            }

        } else {

            // If ISIN is not set, the record is not relevant. 
            continue;
        }

        const date = dayjs(`${record.date} ${record.time}:00`, "DD-MM-YYYY HH:mm");

        // Add record to export.
        exportFile.activities.push({
            accountId: process.env.GHOSTFOLIO_ACCOUNT_ID,
            comment: marker,
            fee: fees,
            quantity: numberShares,
            type: orderType,
            unitPrice: unitPrice,
            currency: "",
            dataSource: "YAHOO",
            date: date.format("YYYY-MM-DDTHH:mm:ssZ"),
            symbol: tickers.items.length > 0 ? tickers.items[0].symbol : ""
        });
    }

    // Only export when no error has occured.
    if (!errorExport) {

        console.log("Processing complete, writing to file..")

        const result = JSON.stringify(exportFile);
        fs.writeFileSync("ghostfolio-degiro.json", result, { encoding: "utf-8" });

        console.log("Wrote data to 'ghostfolio-degiro.json'!");
    }
});
