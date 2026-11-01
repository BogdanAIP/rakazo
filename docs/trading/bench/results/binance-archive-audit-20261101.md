# Binance USD-M historical archive вЂ” preliminary source audit (2026-11-01)

Research-only catalogue and 22 original ZIP checks. NOT a frozen or backtested Binance panel.

## Coverage and as-of listing inventory

- Public Binance S3 inventory: 900 USDT contract folders with monthly 1-hour candle ZIPs; 924 with monthly funding ZIPs; 900 with both; 24 funding-only, excluded until candles are proven.
- Private inventory records first/last observed original S3 ZIP object keys, their months, and SHA256 of each S3 listing response. A ZIP month is not an exact listing/delisting timestamp; refine from original candle timestamps. No current exchangeInfo used.
- Earliest original monthly candle+funding pair in the catalogue: 2020-01. No BTCUSDT monthly 2019-09 through 2019-12 files found.

| Month | Symbols with both file types |
|---|---:|
| 2020-01 | 11 |
| 2020-02 | 23 |
| 2020-06 | 30 |
| 2020-12 | 80 |
| 2021-01 | 86 |
| 2023-10 | 227 |

## Source-content verification (January 2020)

- Downloaded original candle and funding ZIPs for all 11 contracts with both Jan2020 files, validated 22 official .CHECKSUM SHA256 digests and ZIP CRC. Originals and receipts stay private.
- Native USDT quote-volume column (8th CSV value, index 7) present and numeric in every observed candle for the 11 files. No face-value inference.
- Full Jan1вЂ“Jan31 windows (744 hourly bars plus 93 funding settlements): BCHUSDT, BTCUSDT, ETHUSDT. Others have partial January history.
- Examples: XRPUSDT 616 bars/77 settlements; ADAUSDT 16 bars/37 settlements. Funding may precede first observed candle. Do not infer continuity from ZIP presence.

## Historic contracts with early last file

| Symbol | First 1h ZIP month | Last 1h ZIP month |
|---|---|---|
| LUNAUSDT | 2021-01 | 2022-05 |
| ANCUSDT | 2022-03 | 2022-05 |
| BTTUSDT | 2021-04 | 2022-01 |
| BZRXUSDT | 2020-09 | 2021-12 |

## Restrictions

- The point-in-time tradable universe must derive from first/last observed bars, not a present-day symbol list or the entire catalogue.
- Independently audit exact funding-clock coverage, quote volume, monthly continuity, missing source hours, delisted dates, time units, and SHA receipts before panel build or freeze.
- All 22 original ZIPs, SHA receipts and full 900-symbol monthly inventory remain private on Windows Rakazo.
- No Binance panel built, no Binance evaluation, no holdout or trading operations.
