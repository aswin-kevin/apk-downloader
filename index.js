const puppeteer = require('puppeteer');
const fs = require('fs')
const path = require("path")
const request = require('request')

packageName = ""
downloadUrl = ""

async function run () {

    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    try {
        console.log("Searching for APK File ==>> " + packageName)

        await page.goto("https://apk.support/download-app/" + packageName)
        await page.waitForSelector("#down_b")
        await page.click("#down_b")

        await page.waitForSelector(".dvContents")

        const hrefLink = await page.evaluate(
            () => Array.from(
            document.querySelectorAll('a[href]'),
            a => a.getAttribute('href')
            )
        );

        console.log("APK File Found ==>> " + packageName)

        for (let index = 0; index < hrefLink.length; index++) {
            const element = hrefLink[index];
            if (element.includes("services.googleapis.cn") | element.includes("play.googleapis.com")) {
                downloadUrl = element
                break
            }
        }

        console.log("Download started ==>> " + packageName)

        fs.mkdir("Downloads", (err) => {});

        const filePath = path.join(process.cwd() , "Downloads" ,packageName + '.apk')

        const download = (url, path, callback) => {
            request.head(url, (err, res, body) => {
            request(url)
                .pipe(fs.createWriteStream(path))
                .on('close', callback)
            })
        }

        download(downloadUrl, filePath, () => {
            console.log("✅ Download completed ==>> " + packageName)
            browser.close()
        })
    } catch (e) {
        console.log(e)
        console.log("APK file not exists ==>> " + packageName)
        browser.close()
    }
}

module.exports.downloadAPK = function(packagename) {
    packageName = packagename
    run()
}