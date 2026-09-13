/** Real-time streams: Lazer SSE prices + Pusher order events. */

import { Avantis } from "avantis-sdk";

const client = new Avantis();

// Lazer feed ids come from the pair snapshot:
const eth = await client.markets.pair("ETH/USD");
const btc = await client.markets.pair("BTC/USD");
const feedIds = [eth.lazerFeed?.feedId, btc.lazerFeed?.feedId].filter(
  (id): id is number => id !== undefined && id !== null,
);

const stream = client.lazerPriceStream(feedIds);
let ticks = 0;
void stream.run((update) => {
  console.log(
    `feed ${update.feedId}: ${update.price} (bid ${update.bestBid} ask ${update.bestAsk})`,
  );
  if (++ticks >= 10) stream.stop();
});

// Order execution events for your trader (Pusher public channel):
if (client.config.pusherKey) {
  const orders = client.orderEventStream();
  void orders.run((event) => console.log("order event:", event.event, event.data));
  setTimeout(() => orders.stop(), 30_000);
}

// `for await` also works:
// for await (const update of client.lazerPriceStream(feedIds)) { ... }
