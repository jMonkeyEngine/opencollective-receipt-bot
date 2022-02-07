# OpenCollective Receipt Bot

A bot that submits mailed receipts to opencollective expenses and notifies regarding the outcome on telegram.

## Usage
1. Clone this repo
2. Build with
```console
docker build -t oc-receipt-bot .
```
3. Put your config file in `/srv/jme-oc-receipt-bot/config.json`
4. Run
```console
docker run \
-d \
--restart=always \
--name="jme-oc-receipt-bot" \
--read-only \
-v /srv/jme-oc-receipt-bot/config.json:/app/config.json:ro \
--tmpfs /tmp \
 oc-receipt-bot
```
