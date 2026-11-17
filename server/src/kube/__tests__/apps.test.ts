import { describe, expect, it } from "vitest";
import {
  appHost,
  appName,
  appObjects,
  copyHost,
  databaseName,
  databaseSecret,
  imageRepos,
  objectPath,
  tenantNamespace,
  tenantObjects,
  type AppCopy,
} from "../apps.ts";

const app: AppCopy = {
  tenantId: 3,
  projectId: 7,
  slug: "notes",
  copy: "staging",
  host: "notes-a1b2c3",
  domain: "apps.schmeide.com",
  registry: "schmeide.azurecr.io",
  commit: "a".repeat(40),
};

type Meta = { name: string; namespace?: string; labels?: Record<string, string> };
type Obj = { apiVersion: string; kind: string; metadata: Meta; spec?: Record<string, unknown> };
type Container = {
  name: string;
  image: string;
  command?: string[];
  ports?: { containerPort: number }[];
  env?: { name: string; value?: string; valueFrom?: unknown }[];
  securityContext: Record<string, unknown>;
  volumeMounts?: { mountPath: string }[];
};
type DeploymentShape = Obj & {
  spec: {
    replicas: number;
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        automountServiceAccountToken: boolean;
        securityContext: Record<string, unknown>;
        initContainers: Container[];
        containers: Container[];
      };
    };
  };
};
type IngressShape = Obj & {
  spec: {
    ingressClassName: string;
    tls?: unknown;
    defaultBackend?: unknown;
    rules: { host: string; http: { paths: { backend: { service: { name: string } } }[] } }[];
  };
};

const byKind = (objects: readonly object[]) =>
  Object.fromEntries((objects as Obj[]).map((object) => [object.kind, object]));

describe("names", () => {
  it("names a tenant's namespace, each copy, its database, and its images", () => {
    expect(tenantNamespace(3)).toBe("tenant-3");
    expect(appName(7, "production")).toBe("app-7");
    expect(appName(7, "staging")).toBe("app-7-staging");
    expect(databaseName(7, "production")).toBe("app_7");
    expect(databaseName(7, "staging")).toBe("app_7_staging");
    expect(imageRepos(3, "notes")).toEqual({ web: "apps/t3/notes/web", api: "apps/t3/notes/api" });
  });

  it("gives an app an unguessable host whose staging label fits in 63 characters", () => {
    const host = appHost("notes");
    expect(host).toMatch(/^notes-[a-z0-9]{6}$/);
    expect(appHost("notes")).not.toBe(host);
    const long = appHost(`${"a".repeat(46)}-bcdef`);
    expect(long).toMatch(/^a{46}-[a-z0-9]{6}$/);
    expect(copyHost(long, "staging").length).toBeLessThanOrEqual(63);
    expect(copyHost("notes-a1b2c3", "production")).toBe("notes-a1b2c3");
    expect(copyHost("notes-a1b2c3", "staging")).toBe("notes-a1b2c3--staging");
  });
});

describe("tenantObjects", () => {
  const objects = byKind(tenantObjects(3));

  it("creates a namespace the worker's admission policy accepts", () => {
    expect(objects.Namespace.metadata).toEqual({
      name: "tenant-3",
      labels: {
        "schmeide.app/tenant": "3",
        "pod-security.kubernetes.io/enforce": "restricted",
      },
    });
  });

  it("binds only schmeide-tenant-deployer, only to the worker", () => {
    expect(objects.RoleBinding).toMatchObject({
      metadata: { namespace: "tenant-3" },
      roleRef: { kind: "ClusterRole", name: "schmeide-tenant-deployer" },
      subjects: [{ kind: "ServiceAccount", name: "schmeide-worker", namespace: "schmeide-app" }],
    });
  });

  it("caps the tenant and allows only Traefik in and DNS and Postgres out", () => {
    expect(objects.ResourceQuota.spec).toMatchObject({
      hard: { pods: "20", "services.loadbalancers": "0", "services.nodeports": "0" },
    });
    expect(objects.LimitRange.metadata.namespace).toBe("tenant-3");
    const policy = objects.NetworkPolicy.spec as {
      podSelector: object;
      policyTypes: string[];
      ingress: { from: unknown[]; ports: unknown[] }[];
      egress: { ports: { port: number }[] }[];
    };
    expect(policy.podSelector).toEqual({});
    expect(policy.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.ingress).toEqual([
      {
        from: [
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "traefik" } } },
        ],
        ports: [{ protocol: "TCP", port: 8080 }],
      },
    ]);
    expect(policy.egress.flatMap((rule) => rule.ports.map((port) => port.port))).toEqual([
      53, 53, 5432,
    ]);
  });
});

describe("appObjects", () => {
  const objects = byKind(appObjects(app));
  const deployment = objects.Deployment as DeploymentShape;
  const pod = deployment.spec.template.spec;

  it("runs the commit's web and api images, migrating first", () => {
    expect(deployment.metadata).toMatchObject({ name: "app-7-staging", namespace: "tenant-3" });
    expect(deployment.spec.replicas).toBe(1);
    expect(pod.containers.map((container) => [container.name, container.image])).toEqual([
      ["web", `schmeide.azurecr.io/apps/t3/notes/web:${app.commit}`],
      ["api", `schmeide.azurecr.io/apps/t3/notes/api:${app.commit}`],
    ]);
    expect(pod.initContainers[0]).toMatchObject({
      name: "migrate",
      image: `schmeide.azurecr.io/apps/t3/notes/api:${app.commit}`,
      command: ["node", "src/migrate.ts"],
    });
    for (const container of [...pod.initContainers, pod.containers[1]])
      expect(container.env).toContainEqual({
        name: "DATABASE_URL",
        valueFrom: { secretKeyRef: { name: "app-7-staging", key: "DATABASE_URL" } },
      });
  });

  it("points nginx at the api in the same pod", () => {
    expect(pod.containers[0].env).toEqual([
      { name: "API_UPSTREAM", value: "http://127.0.0.1:3000" },
    ]);
  });

  it("meets the restricted pod security level with only /tmp and nginx's conf.d writable", () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    for (const container of [...pod.initContainers, ...pod.containers]) {
      expect(container.securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      });
      expect(container.securityContext.runAsUser).toEqual(expect.any(Number));
      expect(container.volumeMounts?.map((mount) => mount.mountPath)).toEqual(
        container.name === "web" ? ["/tmp", "/etc/nginx/conf.d"] : ["/tmp"]
      );
    }
  });

  it("routes the copy's host on the apps domain with no TLS Secret or default backend", () => {
    const ingress = objects.Ingress as IngressShape;
    expect(ingress.spec.ingressClassName).toBe("traefik");
    expect(ingress.spec.tls).toBeUndefined();
    expect(ingress.spec.defaultBackend).toBeUndefined();
    expect(ingress.spec.rules.map((rule) => rule.host)).toEqual([
      "notes-a1b2c3--staging.apps.schmeide.com",
    ]);
    expect(ingress.spec.rules[0].http.paths[0].backend.service.name).toBe("app-7-staging");
    expect(objects.Service.metadata.labels).toEqual({
      "schmeide.app/tenant": "3",
      "schmeide.app/project": "7",
      "schmeide.app/copy": "staging",
    });
  });

  it("keeps the copy's database URL in its own Secret", () => {
    expect(
      databaseSecret(app, "postgres://app_7_staging:pw@db.example:5432/app_7_staging")
    ).toMatchObject({
      kind: "Secret",
      metadata: { name: "app-7-staging", namespace: "tenant-3" },
      stringData: { DATABASE_URL: "postgres://app_7_staging:pw@db.example:5432/app_7_staging" },
    });
  });
});

describe("objectPath", () => {
  it("finds each object's API path", () => {
    const objects = byKind([...tenantObjects(3), ...appObjects(app)]);
    expect(objectPath(objects.Namespace)).toBe("/api/v1/namespaces/tenant-3");
    expect(objectPath(objects.Deployment)).toBe(
      "/apis/apps/v1/namespaces/tenant-3/deployments/app-7-staging"
    );
    expect(objectPath(objects.Ingress)).toBe(
      "/apis/networking.k8s.io/v1/namespaces/tenant-3/ingresses/app-7-staging"
    );
    expect(objectPath(objects.RoleBinding)).toBe(
      "/apis/rbac.authorization.k8s.io/v1/namespaces/tenant-3/rolebindings/schmeide-tenant-deployer"
    );
  });
});
