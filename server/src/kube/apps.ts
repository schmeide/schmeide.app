// What a deployed app is on the cluster (docs/stage2.md, "Deploy and hosting"): a tenant-<id>
// namespace per business with its quota, defaults and network policy, and per copy of each app
// (production and staging) one Deployment, Service, Ingress and DATABASE_URL Secret. Pure: what
// to apply, never how.
import { randomInt } from "node:crypto";
import type { Copy } from "../services/resources.ts";
import { LABELS, restricted } from "./jobs.ts";

export const COPY_LABEL = "schmeide.app/copy";
// The worker's service account (schmeide/iac gitops/schmeide/apps/schmeide-worker.yaml), which
// binds the deployer role to itself in each tenant namespace.
export const WORKER_ACCOUNT = { name: "schmeide-worker", namespace: "schmeide-app" } as const;
export const DEPLOYER_ROLE = "schmeide-tenant-deployer";

// The template's images (schmeide/template, "The template contract" in docs/stage2.md):
// nginx-unprivileged on 8080 as uid 101, its config written from a template into conf.d at
// startup, and node on 3000 as uid 1000 with /healthz. A template that moves them moves these.
export const WEB_PORT = 8080;
export const API_PORT = 3000;
const WEB_UID = 101;
const API_UID = 1000;

export const tenantNamespace = (tenantId: number): string => `tenant-${tenantId}`;
export const appName = (projectId: number, copy: Copy): string =>
  copy === "production" ? `app-${projectId}` : `app-${projectId}-staging`;
export const databaseName = (projectId: number, copy: Copy): string =>
  copy === "production" ? `app_${projectId}` : `app_${projectId}_staging`;
export const imageRepos = (tenantId: number, slug: string) =>
  ({ web: `apps/t${tenantId}/${slug}/web`, api: `apps/t${tenantId}/${slug}/api` }) as const;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
// Production's first label, chosen once per project: the address is the only lock until #84, so
// six random characters follow the slug, cut to 47 so `--staging` still fits in 63.
export const appHost = (slug: string): string =>
  `${slug.slice(0, 47).replace(/-+$/, "")}-${Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")}`;
// One label, never a subdomain: the wildcard certificate covers one.
export const copyHost = (host: string, copy: Copy): string =>
  copy === "production" ? host : `${host}--staging`;

export type AppCopy = {
  readonly tenantId: number;
  readonly projectId: number;
  readonly slug: string;
  readonly copy: Copy;
  // projects.host
  readonly host: string;
  // The apps domain, such as apps.schmeide.com.
  readonly domain: string;
  // The registry's login server, such as schmeide.azurecr.io.
  readonly registry: string;
  readonly commit: string;
};

export const copyUrl = (app: Pick<AppCopy, "host" | "domain" | "copy">): string =>
  `https://${copyHost(app.host, app.copy)}.${app.domain}`;

const tenantLabels = (tenantId: number) => ({ [LABELS.tenant]: String(tenantId) });
const appLabels = (app: AppCopy) => ({
  ...tenantLabels(app.tenantId),
  [LABELS.project]: String(app.projectId),
  [COPY_LABEL]: app.copy,
});

// In this order: the namespace, then the binding that lets the worker apply the rest.
export const tenantObjects = (tenantId: number): readonly object[] => {
  const namespace = tenantNamespace(tenantId);
  const metadata = (name: string) => ({ name, namespace, labels: tenantLabels(tenantId) });
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          ...tenantLabels(tenantId),
          "pod-security.kubernetes.io/enforce": "restricted",
        },
      },
    },
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "RoleBinding",
      metadata: metadata(DEPLOYER_ROLE),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: DEPLOYER_ROLE },
      subjects: [{ kind: "ServiceAccount", ...WORKER_ACCOUNT }],
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: metadata("tenant"),
      // About eight apps at two copies each.
      spec: {
        hard: {
          "requests.cpu": "1",
          "requests.memory": "2Gi",
          "limits.memory": "4Gi",
          pods: "20",
          "services.loadbalancers": "0",
          "services.nodeports": "0",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: metadata("tenant"),
      spec: {
        limits: [
          {
            type: "Container",
            default: { cpu: "200m", memory: "256Mi" },
            defaultRequest: { cpu: "20m", memory: "64Mi" },
          },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: metadata("tenant"),
      // Everything else is denied: no internet, no other namespace, no other app's port.
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "traefik" } } },
            ],
            ports: [{ protocol: "TCP", port: WEB_PORT }],
          },
        ],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
          {
            // ponytail: Postgres on any private address; the server's subnet CIDR if one is set.
            to: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map((cidr) => ({
              ipBlock: { cidr },
            })),
            ports: [{ protocol: "TCP", port: 5432 }],
          },
        ],
      },
    },
  ];
};

export const databaseSecret = (app: AppCopy, databaseUrl: string): object => ({
  apiVersion: "v1",
  kind: "Secret",
  type: "Opaque",
  metadata: {
    name: appName(app.projectId, app.copy),
    namespace: tenantNamespace(app.tenantId),
    labels: appLabels(app),
  },
  stringData: { DATABASE_URL: databaseUrl },
});

const tmp = [{ name: "tmp", mountPath: "/tmp" }];

// The copy's Deployment, Service and Ingress. `replicas` 0 is a stopped copy.
export const appObjects = (app: AppCopy, replicas = 1): readonly object[] => {
  const name = appName(app.projectId, app.copy);
  const namespace = tenantNamespace(app.tenantId);
  const labels = appLabels(app);
  const metadata = { name, namespace, labels };
  const repos = imageRepos(app.tenantId, app.slug);
  const api = `${app.registry}/${repos.api}:${app.commit}`;
  const databaseUrl = {
    name: "DATABASE_URL",
    valueFrom: { secretKeyRef: { name, key: "DATABASE_URL" } },
  };
  const user = (uid: number) => ({ ...restricted, runAsUser: uid, runAsGroup: uid });
  return [
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata,
      spec: {
        replicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
            initContainers: [
              {
                // The Compose `migrate` service: the copy's database, migrated forward.
                name: "migrate",
                image: api,
                workingDir: "/app/backend",
                command: ["node", "src/migrate.ts"],
                env: [databaseUrl],
                securityContext: user(API_UID),
                resources: {
                  requests: { cpu: "40m", memory: "128Mi" },
                  limits: { cpu: "300m", memory: "384Mi" },
                },
                volumeMounts: tmp,
              },
            ],
            containers: [
              {
                // nginx: the built frontend, and /api/ proxied to the api on 127.0.0.1.
                name: "web",
                image: `${app.registry}/${repos.web}:${app.commit}`,
                env: [{ name: "API_UPSTREAM", value: `http://127.0.0.1:${API_PORT}` }],
                ports: [{ name: "http", containerPort: WEB_PORT }],
                readinessProbe: { httpGet: { path: "/", port: WEB_PORT }, periodSeconds: 5 },
                securityContext: user(WEB_UID),
                resources: {
                  requests: { cpu: "20m", memory: "32Mi" },
                  limits: { cpu: "200m", memory: "128Mi" },
                },
                volumeMounts: [...tmp, { name: "nginx-conf", mountPath: "/etc/nginx/conf.d" }],
              },
              {
                name: "api",
                image: api,
                env: [{ name: "PORT", value: String(API_PORT) }, databaseUrl],
                readinessProbe: {
                  httpGet: { path: "/healthz", port: API_PORT },
                  periodSeconds: 5,
                },
                securityContext: user(API_UID),
                resources: {
                  requests: { cpu: "40m", memory: "128Mi" },
                  limits: { cpu: "300m", memory: "384Mi" },
                },
                volumeMounts: tmp,
              },
            ],
            volumes: [
              { name: "tmp", emptyDir: { sizeLimit: "256Mi" } },
              { name: "nginx-conf", emptyDir: { sizeLimit: "1Mi" } },
            ],
          },
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata,
      spec: {
        selector: labels,
        ports: [{ name: "http", port: WEB_PORT, targetPort: WEB_PORT }],
      },
    },
    {
      // No tls: Traefik's default TLSStore serves the *.apps wildcard on its https entry point.
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      metadata,
      spec: {
        ingressClassName: "traefik",
        rules: [
          {
            host: `${copyHost(app.host, app.copy)}.${app.domain}`,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: { service: { name, port: { name: "http" } } },
                },
              ],
            },
          },
        ],
      },
    },
  ];
};

const PLURALS: Readonly<Record<string, string>> = {
  Namespace: "namespaces",
  RoleBinding: "rolebindings",
  ResourceQuota: "resourcequotas",
  LimitRange: "limitranges",
  NetworkPolicy: "networkpolicies",
  Secret: "secrets",
  Deployment: "deployments",
  Service: "services",
  Ingress: "ingresses",
};

type Kinded = {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: { readonly name: string; readonly namespace?: string };
};

// Where the API serves an object of one of the kinds above.
export const objectPath = (object: object): string => {
  const { apiVersion, kind, metadata } = object as Kinded;
  const plural = PLURALS[kind];
  if (!plural) throw new Error(`No API path known for ${kind}`);
  return [
    apiVersion === "v1" ? "/api/v1" : `/apis/${apiVersion}`,
    ...(metadata.namespace ? ["namespaces", encodeURIComponent(metadata.namespace)] : []),
    plural,
    encodeURIComponent(metadata.name),
  ].join("/");
};
