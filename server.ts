/**
 * food-orders-mcp — single-file MCP server (Express 5 + Streamable HTTP).
 *
 * Endpoints
 *   POST /mcp      JSON-RPC 2.0, stateless Streamable HTTP (SSE responses)
 *   GET  /healthz  liveness probe
 *
 * Env
 *   PORT            default 3000
 *   HOST            default 0.0.0.0
 *   MCP_AUTH_TOKEN  when set, /mcp requires "Authorization: Bearer <token>"
 *
 * Tools
 *   getOrders  summary list of mock food-delivery orders
 *   getOrder   full detail for one order (orderId is a UUID)
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Mock data                                                          */
/* ------------------------------------------------------------------ */

type OrderStatus = 'placed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';

type OrderItem = {
  name: string;
  quantity: number;
  unitPrice: number;
};

type Order = {
  id: string;
  orderNumber: string;
  restaurant: string;
  status: OrderStatus;
  placedAt: string;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  cancellationReason?: string;
  customer: {
    name: string;
    phone: string;
    deliveryAddress: string;
  };
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  tax: number;
  tip: number;
  total: number;
  currency: 'USD';
  courier: {
    name: string;
    vehicle: 'bike' | 'scooter' | 'car';
  } | null;
  statusHistory: { status: OrderStatus; at: string }[];
};

const round = (n: number): number => Math.round(n * 100) / 100;

type OrderSeed = Omit<Order, 'subtotal' | 'total'>;

const SEEDS: OrderSeed[] = [
  {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    orderNumber: 'FD-24081',
    restaurant: "Nonna's Wood-Fired Pizza",
    status: 'preparing',
    placedAt: '2026-11-16T11:05:00Z',
    estimatedDeliveryAt: '2026-11-16T12:10:00Z',
    deliveredAt: null,
    customer: {
      name: 'Maya Chen',
      phone: '+1-503-555-0142',
      deliveryAddress: '418 SE Ash St, Apt 3B, Portland, OR 97214',
    },
    items: [
      { name: 'Margherita Pizza (12")', quantity: 1, unitPrice: 16.5 },
      { name: 'Garlic Knots (6)', quantity: 1, unitPrice: 6.0 },
      { name: 'San Pellegrino', quantity: 2, unitPrice: 3.25 },
    ],
    deliveryFee: 3.99,
    tax: 2.47,
    tip: 5.0,
    currency: 'USD',
    courier: null,
    statusHistory: [
      { status: 'placed', at: '2026-11-16T11:05:00Z' },
      { status: 'preparing', at: '2026-11-16T11:09:00Z' },
    ],
  },
  {
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    orderNumber: 'FD-24082',
    restaurant: 'Sakura Ramen House',
    status: 'out_for_delivery',
    placedAt: '2026-11-16T10:48:00Z',
    estimatedDeliveryAt: '2026-11-16T11:35:00Z',
    deliveredAt: null,
    customer: {
      name: 'Devon Park',
      phone: '+1-503-555-0188',
      deliveryAddress: '2210 NW Kearney St, Portland, OR 97210',
    },
    items: [
      { name: 'Tonkotsu Ramen', quantity: 2, unitPrice: 15.0 },
      { name: 'Pork Gyoza (6)', quantity: 1, unitPrice: 7.5 },
      { name: 'Matcha Cheesecake', quantity: 1, unitPrice: 6.0 },
    ],
    deliveryFee: 4.49,
    tax: 3.7,
    tip: 6.0,
    currency: 'USD',
    courier: { name: 'Luis Ortega', vehicle: 'scooter' },
    statusHistory: [
      { status: 'placed', at: '2026-11-16T10:48:00Z' },
      { status: 'preparing', at: '2026-11-16T10:55:00Z' },
      { status: 'out_for_delivery', at: '2026-11-16T11:12:00Z' },
    ],
  },
  {
    id: '16fd2706-8baf-433b-82eb-8c7fada847da',
    orderNumber: 'FD-24066',
    restaurant: 'The Green Bowl',
    status: 'delivered',
    placedAt: '2026-11-15T19:02:00Z',
    estimatedDeliveryAt: '2026-11-15T19:40:00Z',
    deliveredAt: '2026-11-15T19:42:00Z',
    customer: {
      name: 'Priya Raman',
      phone: '+1-503-555-0119',
      deliveryAddress: '77 SW Naito Pkwy, Unit 512, Portland, OR 97204',
    },
    items: [
      { name: 'Harvest Grain Bowl', quantity: 1, unitPrice: 13.75 },
      { name: 'Miso Soup', quantity: 1, unitPrice: 4.25 },
      { name: 'Sparkling Yuzu', quantity: 1, unitPrice: 3.5 },
    ],
    deliveryFee: 2.99,
    tax: 1.83,
    tip: 4.0,
    currency: 'USD',
    courier: { name: 'Ana Souza', vehicle: 'bike' },
    statusHistory: [
      { status: 'placed', at: '2026-11-15T19:02:00Z' },
      { status: 'preparing', at: '2026-11-15T19:07:00Z' },
      { status: 'out_for_delivery', at: '2026-11-15T19:24:00Z' },
      { status: 'delivered', at: '2026-11-15T19:42:00Z' },
    ],
  },
  {
    id: '5f47ac10-b0d4-4a2a-9e6f-1f0b7f3c8d21',
    orderNumber: 'FD-24059',
    restaurant: 'Taco Loco',
    status: 'cancelled',
    placedAt: '2026-11-14T20:15:00Z',
    estimatedDeliveryAt: null,
    deliveredAt: null,
    cancellationReason: 'Restaurant closed early — order refunded in full.',
    customer: {
      name: 'Sam Okafor',
      phone: '+1-503-555-0173',
      deliveryAddress: '9 NE Alberta St, Portland, OR 97211',
    },
    items: [
      { name: 'Al Pastor Tacos (3)', quantity: 1, unitPrice: 12.0 },
      { name: 'Elote', quantity: 1, unitPrice: 4.5 },
    ],
    deliveryFee: 2.99,
    tax: 1.4,
    tip: 0,
    currency: 'USD',
    courier: null,
    statusHistory: [
      { status: 'placed', at: '2026-11-14T20:15:00Z' },
      { status: 'cancelled', at: '2026-11-14T20:21:00Z' },
    ],
  },
  {
    id: '9b2f4c6e-1a3d-4e5f-8b7c-2d9e0a1f3b4c',
    orderNumber: 'FD-24031',
    restaurant: 'Bagel & Bloom',
    status: 'delivered',
    placedAt: '2026-11-13T08:24:00Z',
    estimatedDeliveryAt: '2026-11-13T09:05:00Z',
    deliveredAt: '2026-11-13T09:12:00Z',
    customer: {
      name: 'Ruth Delgado',
      phone: '+1-503-555-0164',
      deliveryAddress: '1355 SE Division St, Portland, OR 97202',
    },
    items: [
      { name: 'Everything Bagel', quantity: 2, unitPrice: 2.5 },
      { name: 'Lox Schmear', quantity: 1, unitPrice: 9.0 },
      { name: 'Cold Brew (16oz)', quantity: 1, unitPrice: 4.75 },
    ],
    deliveryFee: 3.49,
    tax: 1.59,
    tip: 3.0,
    currency: 'USD',
    courier: { name: 'Kenji Ito', vehicle: 'bike' },
    statusHistory: [
      { status: 'placed', at: '2026-11-13T08:24:00Z' },
      { status: 'preparing', at: '2026-11-13T08:31:00Z' },
      { status: 'out_for_delivery', at: '2026-11-13T08:52:00Z' },
      { status: 'delivered', at: '2026-11-13T09:12:00Z' },
    ],
  },
];

// Subtotals/totals are derived so the mock data can never be internally inconsistent.
const ORDERS: Order[] = SEEDS.map((seed) => {
  const subtotal = round(
    seed.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0),
  );
  return {
    ...seed,
    subtotal,
    total: round(subtotal + seed.deliveryFee + seed.tax + seed.tip),
  };
});

function summarize(order: Order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    restaurant: order.restaurant,
    status: order.status,
    itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
    total: order.total,
    currency: order.currency,
    placedAt: order.placedAt,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
    deliveredAt: order.deliveredAt,
  };
}

function detailOf(order: Order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    restaurant: order.restaurant,
    status: order.status,
    placedAt: order.placedAt,
    estimatedDeliveryAt: order.estimatedDeliveryAt,
    deliveredAt: order.deliveredAt,
    ...(order.cancellationReason ? { cancellationReason: order.cancellationReason } : {}),
    customer: order.customer,
    items: order.items.map((item) => ({
      ...item,
      lineTotal: round(item.quantity * item.unitPrice),
    })),
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    tax: order.tax,
    tip: order.tip,
    total: order.total,
    currency: order.currency,
    courier: order.courier,
    statusHistory: order.statusHistory,
  };
}

/* ------------------------------------------------------------------ */
/* MCP server + tools                                                 */
/* ------------------------------------------------------------------ */

function createServer(): McpServer {
  const server = new McpServer(
    { name: 'food-orders-mcp', version: '1.0.0' },
    {
      instructions:
        'Mock food-delivery order system. Call getOrders to list recent orders, then ' +
        'getOrder with an orderId (UUID) from that list to get full details. ' +
        'The data is fake and read-only; nothing here can be changed.',
    },
  );

  server.registerTool(
    'getOrders',
    {
      title: 'List orders',
      description:
        'List recent food-delivery orders as summaries: id, orderNumber, restaurant, ' +
        'status, itemCount, total, placedAt, and delivery timestamps. ' +
        'Use the id from this list as orderId for getOrder.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify(ORDERS.map(summarize), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    'getOrder',
    {
      title: 'Get order detail',
      description:
        'Get full details for one order: customer and delivery address, line items, ' +
        'subtotal/delivery fee/tax/tip/total, courier, and status history. ' +
        'The orderId must be a UUID taken from getOrders.',
      inputSchema: {
        orderId: z.uuid().describe('Order UUID, exactly as returned by getOrders'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ orderId }) => {
      const order = ORDERS.find((o) => o.id === orderId.toLowerCase());

      if (!order) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text:
                `No order with id "${orderId}".\n\n` +
                `Known order ids:\n${ORDERS.map((o) => `- ${o.id} (${o.orderNumber}, ${o.status})`).join('\n')}`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(detailOf(order), null, 2),
          },
        ],
      };
    },
  );

  return server;
}

/* ------------------------------------------------------------------ */
/* HTTP layer                                                         */
/* ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(cors());

/** Constant-time bearer check; open when MCP_AUTH_TOKEN is unset. */
function tokenMatches(provided: string | undefined): boolean {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) return true;
  if (!provided) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

const requireAuth: express.RequestHandler = (req, res, next) => {
  const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (tokenMatches(provided)) {
    next();
    return;
  }
  res.status(401).json({
    error: 'unauthorized',
    message: 'Send "Authorization: Bearer <MCP_AUTH_TOKEN>".',
  });
};

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    name: 'food-orders-mcp',
    auth: Boolean(process.env.MCP_AUTH_TOKEN),
    orders: ORDERS.length,
  });
});

// Stateless Streamable HTTP: a fresh server + transport per request.
// Note: no JSON body parser here — the transport reads the raw stream itself.
app.post('/mcp', requireAuth, async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// Stateless mode offers no server->client SSE stream and no session teardown.
app.all('/mcp', requireAuth, (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    error: 'method_not_allowed',
    message:
      'Stateless Streamable HTTP endpoint. POST JSON-RPC to /mcp; GET/DELETE are not supported.',
  });
});

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`food-orders-mcp listening on http://${HOST}:${PORT}`);
  console.log(`  MCP endpoint : http://localhost:${PORT}/mcp`);
  console.log(`  health check : http://localhost:${PORT}/healthz`);
  console.log(
    `  auth         : ${
      process.env.MCP_AUTH_TOKEN
        ? 'bearer token required'
        : 'OPEN (set MCP_AUTH_TOKEN to require a token)'
    }`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);

    // Containers are killed if they linger; don't let an open SSE socket delay us.
    const forceExit = setTimeout(() => {
      console.warn('Open connections remain after 5s — forcing exit.');
      process.exit(1);
    }, 5_000);
    forceExit.unref();

    httpServer.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}
