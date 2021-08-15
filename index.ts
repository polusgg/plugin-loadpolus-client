import { LobbyCode } from "@nodepolus/framework/src/util/lobbyCode";
import { UserResponseStructure } from "@polusgg/module-polusgg-auth-api/src/types/userResponseStructure";
import { EnumValue } from "@polusgg/plugin-polusgg-api/src/packets/root/setGameOption";
import { GameState, Language, Level, Scene } from "@nodepolus/framework/src/types/enums";
import { ServiceType } from "@polusgg/plugin-polusgg-api/src/types/enums";
import { Services } from "@polusgg/plugin-polusgg-api/src/services";
import { LobbyInstance } from "@nodepolus/framework/src/api/lobby";
import { BasePlugin } from "@nodepolus/framework/src/api/plugin";
import { readFileSync } from "fs";
import Redis from "ioredis";
import got from "got";
import os from "os";
import { DisconnectReason } from "@nodepolus/framework/src/types";
import { MarkAssBrownPacket } from "./packets/markAssBrown";
import { RedirectPacket } from "@nodepolus/framework/src/protocol/packets/root";
import { PlayerInstance } from "@nodepolus/framework/src/api/player";

const isInDocker = (): boolean => {
  const platform = os.platform();

  if (platform === "darwin" || platform === "win32") {
    return false;
  }

  const file = readFileSync("/proc/self/cgroup", "utf-8");

  return file.indexOf("/docker") !== -1;
};

const getMeta = async (path: string): Promise<string | undefined> => {
  path = path.startsWith("/") ? path.substr(1) : path;

  try {
    const { body } = await got(`http://169.254.169.254/metadata/v1/${path}`);

    return body;
  } catch (error) {
    return undefined;
  }
};

const getDropletName = async (): Promise<string | undefined> => getMeta("hostname");

const getDropletAddress = async (): Promise<string | undefined> => getMeta("interfaces/public/0/ipv4/address");

type LoadPolusConfig = {
  nodeName: string;
  publicIp: string;
  redis: Redis.RedisOptions;
  creator: boolean;
};

enum NotificationType {
  SystemAlert = "systemAlert",
}

type SystemAlert = {
  type: NotificationType.SystemAlert;
  contents: string;
};

// NOTE: add shit to this union if/when we add more notification types
type Notification = SystemAlert;

export default class extends BasePlugin<Partial<LoadPolusConfig>> {
  private readonly redis: Redis.Redis;

  private registered = false;
  private nodeName = os.hostname();
  private nodeAddress = this.server.getDefaultLobbyAddress();
  private readonly gameOptionsService = Services.get(ServiceType.GameOptions);
  private readonly hudService = Services.get(ServiceType.Hud);
  private readonly serverVersion;
  private readonly subscriberRedis: Redis.Redis;
  private isShuttingDown = false;
  private isPendingShutdown = false;
  private readonly gamecodePromiseAcceptMap = new Map<string, (reason?: any) => void>();
  private readonly selectedNewNodeMap = new Map<string, Record<string, string>>();

  constructor(config: Partial<LoadPolusConfig>) {
    super({
      name: "LoadPolus",
      version: [1, 0, 0],
    }, undefined, config);

    this.serverVersion = this.getServer().getVersion();

    console.log("npm is doodoo", this.serverVersion);

    const redisPort = parseInt(process.env.NP_REDIS_PORT ?? "", 10);

    config.redis ??= {};
    config.redis.host = process.env.NP_REDIS_HOST?.trim() ?? config.redis.host ?? "127.0.0.1";
    config.redis.port = Number.isInteger(redisPort) ? redisPort : config.redis.port ?? 6379;
    config.redis.password = process.env.NP_REDIS_PASSWORD?.trim() ?? undefined;
    //config.type = process.env.NP_IS_CREATOR_SERVER?.trim();

    if (config.redis.host.startsWith("rediss://")) {
      config.redis.host = config.redis.host.substr("rediss://".length);
      config.redis.tls = {};
      config.redis.connectTimeout = 30000;
    }

    this.redis = new Redis(this.config!.redis);
    this.subscriberRedis = new Redis(this.config!.redis);

    this.redis.on("connect", async () => {
      this.getLogger().info(`Redis connected to ${config.redis!.host}:${config.redis!.port}`);

      if (this.registered) {
        return;
      }

      this.registered = true;

      await this.setNodeName();
      await this.setNodeAddress();

      if (this.config?.creator) {
        this.redis.sadd(`loadpolus.nodes.creator`, this.nodeName);
        this.redis.sadd(`loadpolus.nodes.${this.serverVersion}.creator`, this.nodeName);
      } else {
        this.redis.sadd(`loadpolus.nodes`, this.nodeName);
        this.redis.sadd(`loadpolus.nodes.${this.serverVersion}`, this.nodeName);
      }

      this.redis.hmset(`loadpolus.node.${this.nodeName}`, {
        maintenance: "false",
        host: this.nodeAddress,
        port: `${this.server.getDefaultLobbyPort()}`,
        currentConnections: "0",
        maxConnections: `${this.server.getMaxLobbies() * this.server.getMaxPlayersPerLobby()}`,
        creator: this.config?.creator ? "true" : "false",
        serverVersion: this.serverVersion,
      });

      this.registerEvents();
    });

    this.subscriberRedis.on("connect", () => {
      this.subscriberRedis.on("message", async (channel: string, message: string) => {
        console.log(channel, message);

        switch (channel) {
          case "loadpolus.notifications": {
            const notification: Notification = JSON.parse(message);

            switch (notification.type) {
              case (NotificationType.SystemAlert): {
                this.hudService.displayNotification(notification.contents);
              }
            }
            break;
          }
          case "loadpolus.transferred": {
            const shit = JSON.parse(message);
            const funnyLobbyCode = shit.lobbyCode;
            const userIdWhoJoinedTheFuckingdfsjf = shit.userId;

            if (funnyLobbyCode === undefined) {
              return;
            }

            if (userIdWhoJoinedTheFuckingdfsjf === undefined) {
              return;
            }

            const acceptFunction = this.gamecodePromiseAcceptMap.get(`${funnyLobbyCode}_${userIdWhoJoinedTheFuckingdfsjf}`);

            if (acceptFunction === undefined) {
              console.log("WHY IS IT UNDEFINED IM AGOING INSANE");

              return;
            }

            acceptFunction();
            console.log("called the fucking fnction for", funnyLobbyCode, userIdWhoJoinedTheFuckingdfsjf);

            break;
          }
          case "loadpolus.shutdown": {
            const shutdownInfo = JSON.parse(message);

            console.log("got shutdown message", shutdownInfo);

            if (shutdownInfo.node !== this.nodeName) {
              console.log("skill issue");

              return;
            }

            switch (shutdownInfo.type) {
              case "graceful_immediate":
                console.log("LoadPolus shutting down server");
                // shutdown the server by calling server.close()
                this.server.close().then(async () => {
                  await this.redis.publish("loadpolus.shutdown.alert", JSON.stringify({
                    type: "shutdown_complete",
                    node: this.config?.nodeName,
                  }));
                  process.exit();
                });
                break;

              case "immediate":
                // just kill the server
                console.log("LoadPolus killing server");

                await this.redis.publish("loadpolus.shutdown.alert", JSON.stringify({
                  type: "shutdown_complete",
                  node: this.config?.nodeName,
                }));
                process.kill(process.pid, "SIGKILL");
                break;

              case "graceful_delayed":
                // wait for all lobbies to be destroyed and then shutdown
                this.isPendingShutdown = true;

                //@ts-ignore
                this.server.isShuttingDown = true;

                await this.redis.hmset(`loadpolus.node.${this.nodeName}`, {
                  maintenance: "true",
                });

                this.server.on("server.lobby.creating", event => {
                  event.setDisconnectReason(DisconnectReason.custom("This server is shutting down. Please try again."));
                  event.cancel();
                });


                await this.redis.publish("loadpolus.shutdown.alert", JSON.stringify({
                  type: "shutdown_ack",
                  node: this.config?.nodeName,
                }));

                console.log("Waiting for all lobbies to end before shutting down");

                if (this.server.getLobbies().length == 0) {
                  console.log("Lobby count hit 0, shutting down!");

                  this.server.close().then(async () => {
                    await this.redis.publish("loadpolus.shutdown.alert", JSON.stringify({
                      type: "shutdown_complete",
                      node: this.config?.nodeName,
                    }));

                    process.exit();
                  });

                  return;
                }

                this.server.on("server.lobby.destroyed", event => {
                  if (this.isShuttingDown) { return }
                  // the server hasn't removed the lobby from the list at this point
                  // fuck this
                  console.log("sussy", event.getLobby().getCode());

                  if (this.server.getLobbies().length <= 1) {
                    console.log("Lobby count hit 0, shutting down!");
                    this.isShuttingDown = true;

                    this.server.close().then(async () => {
                      await this.redis.publish("loadpolus.shutdown.alert", JSON.stringify({
                        type: "shutdown_complete",
                        node: this.config?.nodeName,
                      }));

                      process.exit();
                    });
                  }

                });
                this.server.on("game.ended", async event => {
                  console.log("the got damn");
                  (async () => {
                    console.log("the motherfuckin uhhh");
                    const creator = event.getGame().getLobby().getCreator();
                    const lobby = event.getGame().getLobby();

                    if (creator === undefined) {
                      console.log("panic!!!!!!!!! there's no creator for this lobby??");
                      lobby.close();
                      event.cancel();
                      return;
                    }

                    const targetVersion = await this.redis.hget("loadpolus.config", "targetVersion");
                    if (targetVersion === null) {
                      console.log("panic!!!!!!!!! loadpolus.config[targetVersion] is undefined??");
                      lobby.close();
                      event.cancel();
                      return;
                    }

                    const userData = creator.getMeta<UserResponseStructure>("pgg.auth.self");
                    const serverKey = `loadpolus.nodes.${targetVersion}${userData.perks.includes("server.access.creator") ? ".creator" : ""}`;
                    const newServer = await this.selectServer(serverKey);

                    const connections = lobby.getConnections();

                    if (newServer == undefined) {
                      for (let i=0; i<connections.length; i++) {
                        const connection = connections[i];

                        connection.disconnect(DisconnectReason.custom("The server you were previously on has shut down for maintenance. Please try again later."));
                      }

                      return;
                    }

                    this.selectedNewNodeMap.set(lobby.getCode(), newServer);

                    // fuck this fuck this fuck this fuck this fuck this fuck this fuck this fuck this fuck this fuck this fuck th

                    const hosts = lobby.getActingHosts();
                    const nonHosts = lobby.getConnections().filter(connection => connection.isActingHost());
                    const possibleHosts = hosts.concat(nonHosts);

                    for (let i=0; i<possibleHosts.length; i++) {
                      const currentConnection = possibleHosts[i];
                      console.log("i hate", currentConnection.getName());

                      let acceptFunction;

                      const funnyPromise = new Promise((accept, reject) => {
                        acceptFunction = accept;
                        setTimeout(() => {
                          console.log("epic timeout (hopefully the promise was actually resolved)");
                          reject("epic timeout fail");
                        }, 6000);
                      });

                      this.gamecodePromiseAcceptMap.set(`${lobby.getCode()}_${userData.client_id}`, acceptFunction);
                      console.log("added promise to the funny map");


                      await this.redis.set(`loadpolus.transfer.user.${userData.client_id}`, lobby.getCode());
                      await this.redis.expire(`loadpolus.transfer.user.${userData.client_id}`, 180);

                      await currentConnection.sendReliable([new MarkAssBrownPacket(newServer!.host, parseInt(newServer!.port))]);
                      console.log("racism");

                      try {
                        await funnyPromise;

                        console.log("EPIC WIN HOLY SHIT");
                        return;
                      } catch (error) {
                        console.log("fuck (timed out before the funny happened)");
                      } finally {
                        console.log("yo mama (the epic final(ly))");
                        this.gamecodePromiseAcceptMap.delete(`${lobby.getCode()}_${userData.client_id}`);
                        console.log("moving onto the next one...");
                        continue;
                      }
                    }

                    console.log("WHAT THE FUCK (x2) WE SOMEHOW FAILED ALL HOSTS");
                  })();
                });

                this.server.on("server.lobby.join", async event => {
                  console.log("got join", event.getConnection().getCurrentScene());

                  const lobby = event.getLobby();

                  if (lobby == undefined) {
                    return;
                  }

                  if (event.getConnection().getCurrentScene() == Scene.EndGame) {
                    console.log("funny reconnect logic");

                    const newServer = this.selectedNewNodeMap.get(lobby.getCode());

                    if (newServer === undefined) {
                      event.setDisconnectReason(DisconnectReason.custom("Tried to send you to the new server but not present in selectedNewNodeMap?!"));
                      event.cancel();

                      return;
                    }

                    event.getConnection().sendReliable([new RedirectPacket(newServer.host, parseInt(newServer.port))]);
                    console.log("sent player to new server on", newServer.host, newServer.port);
                  }
                });
                break;
            }
          }
        }
      });

      this.subscriberRedis.subscribe("loadpolus.notifications");
      this.subscriberRedis.subscribe("loadpolus.shutdown");
      this.subscriberRedis.subscribe("loadpolus.transferred");
    });
  }

  private registerEvents(): void {
    this.server.on("server.lobby.creating", async event => {
      const authData = event.getConnection().getMeta<UserResponseStructure>("pgg.auth.self");
      let currentCode = authData.settings["lobby.code.custom"] ? authData.settings["lobby.code.custom"] : event.getLobbyCode();
      let remainingTries = 10;

      while (remainingTries > 0) {
        const fuck = await this.redis.hgetall(`loadpolus.lobby.${currentCode}`);

        if (Object.keys(fuck).length == 0) {
          event.setLobbyCode(currentCode);

          return;
        }

        currentCode = LobbyCode.generate();
        remainingTries--;
      }

      // dream luck

      event.setDisconnectReason(DisconnectReason.custom("dream luck (or the server is full)"));
      event.cancel();
    });

    this.server.on("server.lobby.created", event => {
      const lobby = event.getLobby();
      const options = lobby.getOptions();

      this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
        host: this.nodeAddress,
        port: this.server.getDefaultLobbyPort(),
        level: Level[options.getLevels()[0]],
        impostorCount: options.getImpostorCount(),
        language: Language[options.getLanguages()[0]],
        currentPlayers: 0,
        maxPlayers: options.getMaxPlayers(),
        gameState: GameState[lobby.getGameState()],
        gamemode: "<unknown>",
        "public": lobby.isPublic() ? "true" : "false",
        serverVersion: this.serverVersion,
        creator: this.config?.creator ? "true" : "false",
        transitioning: "false",
      });

      this.redis.sadd(`loadpolus.node.${this.nodeName}.lobbies`, lobby.getCode());

      const customGameOptions = this.gameOptionsService.getGameOptions<{ gamemode: EnumValue }>(lobby);

      customGameOptions.on("option.gamemode.changed", option => {
        this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
          gamemode: option.getValue().options[option.getValue().index],
        });
      });
    });

    this.server.on("lobby.host.added", event => this.updateHostList(event.getLobby()));
    this.server.on("lobby.host.migrated", event => this.updateHostList(event.getLobby()));
    this.server.on("lobby.host.removed", event => this.updateHostList(event.getLobby()));

    this.server.on("server.lobby.destroyed", event => {
      const code = event.getLobby().getCode();

      this.redis.del(`loadpolus.lobbyUuid.${event.getLobby().getMeta<string>("pgg.log.uuid")}`);
      this.redis.del(`loadpolus.lobby.${code}`);
      this.redis.srem(`loadpolus.node.${this.nodeName}.lobbies`, code);
    });

    this.server.on("player.joined", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.left", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.kicked", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.banned", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("server.lobby.list", event => { event.cancel() });
    this.server.on("game.started", event => {
      this.redis.hmset(`loadpolus.lobby.${event.getGame().getLobby().getCode()}`, {
        gameState: "Started"
      });
    });
    this.server.on("game.ended", event => {
      if (event.isCancelled()) return;
      this.redis.hmset(`loadpolus.lobby.${event.getGame().getLobby().getCode()}`, {
        gameState: "NotStarted"
      });
    });

    this.server.on("player.joined", event => this.handlePlayerJoin(event.getPlayer(), event.getLobby()));
    this.server.on("player.left", event => this.handlePlayerLeave(event.getPlayer()));
    this.server.on("player.kicked", event => this.handlePlayerLeave(event.getPlayer()));
    this.server.on("player.banned", event => this.handlePlayerLeave(event.getPlayer()));

    this.server.on("server.lobby.creating", async (event) => {
      if (this.isPendingShutdown) {
        console.log("server.lobby.creating but the server is shutting down >:(((((((");

        return;
      }

      if (!event.isMigrating()) {
        return;
      }

      console.log("got migrating lobby");

      const userData = event.getConnection().getMeta<UserResponseStructure>("pgg.auth.self");
      const oldLobbyCode = await this.redis.get(`loadpolus.transfer.user.${userData.client_id}`);

      if (oldLobbyCode === null) {
        console.log("no old lobby code?!?!?");

        event.setDisconnectReason(DisconnectReason.custom("Unable to find the previous lobby you were in. Please try again."));
        event.cancel();

        return;
      }

      const possibleLobbyData = await this.redis.hgetall(`loadpolus.lobby.${oldLobbyCode}`);

      if (Object.keys(possibleLobbyData).length > 0) {
        console.log("previous lobby already exists?!?!!");

        event.setDisconnectReason(DisconnectReason.custom("Unable to transfer you to a new server. Please try again."));
        event.cancel();

        return;
      }

      console.log("welcome to hell, the lobby code is", oldLobbyCode);
      event.setLobbyCode(oldLobbyCode);

      await this.redis.publish("loadpolus.transferred", JSON.stringify({
        lobbyCode: oldLobbyCode,
        userId: userData.client_id,
      }));
    });

    this.server.on("player.joined", event => {
      const isLoadpolusLobby = !!event.getLobby().getMeta<boolean | undefined>("loadpolus");
      const hosts = event.getLobby().getMeta<string[] | undefined>("loadpolus.hostUuids");

      if (hosts == undefined || hosts.length == 0) {
        if (isLoadpolusLobby && event.getPlayer().getConnection()?.isActingHost()) {
          event.getPlayer().getConnection()?.syncActingHost(false, true);
        }

        return;
      }

      const hostIndex = hosts.indexOf(event.getPlayer().getMeta<UserResponseStructure>("pgg.auth.self").client_id);

      if (hostIndex == -1) {
        if (isLoadpolusLobby && event.getPlayer().getConnection()?.isActingHost()) {
          event.getPlayer().getConnection()?.syncActingHost(false, true);
        }

        return;
      }

      hosts.splice(hostIndex, 1);
      event.getPlayer().getConnection()?.syncActingHost(true, true);
    });

    this.server.on("lobby.privacy.updated", event => {
      this.redis.hmset(`loadpolus.lobby.${event.getLobby().getCode()}`, {
        "public": event.isPublic() ? "true" : "false",
      });
    });

    this.server.on("lobby.options.updated", event => {
      const lobby = event.getLobby();
      const options = lobby.getOptions();

      this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
        level: Level[options.getLevels()[0]],
        impostorCount: options.getImpostorCount(),
        language: Language[options.getLanguages()[0]],
      });
    });

    if (this.config?.creator) {
      this.server.on("server.lobby.join", event => {
        const connection = event.getConnection();

        if (connection.getMeta<UserResponseStructure>("pgg.auth.self").perks.indexOf("server.access.creator") > -1) {
          event.cancel();
          event.setDisconnectReason(DisconnectReason.custom("You don't have permission to join this lobby."));
        }
      });
    }

    this.server.on("server.close", () => {
      const lobbies = this.server.getLobbies();

      for (let i = 0; i < lobbies.length; i++) {
        const lobby = lobbies[i];

        this.redis.del(`loadpolus.lobby.${lobby.getCode()}`);
        this.redis.del(`loadpolus.lobbyUuid.${lobby.getMeta<string>("pgg.log.uuid")}`)
      }

      if (this.config?.creator) {
        this.redis.srem(`loadpolus.nodes.creator`, this.nodeName);
        this.redis.srem(`loadpolus.nodes.${this.serverVersion}.creator`, this.nodeName);
      } else {
        this.redis.srem(`loadpolus.nodes`, this.nodeName);
        this.redis.srem(`loadpolus.nodes.${this.serverVersion}`, this.nodeName);
      }

      this.redis.del(`loadpolus.node.${this.nodeName}.lobbies`);
      this.redis.del(`loadpolus.node.${this.nodeName}`);
    });
  }

  private updateCurrentPlayers(lobby: LobbyInstance): void {
    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      currentPlayers: lobby.getPlayers().length,
      currentConnections: lobby.getConnections().length,
    });

    this.redis.hmset(`loadpolus.node.${this.nodeName}`, {
      currentConnections: this.server.getConnections().size,
    });

    const players = lobby.getConnections().map(connection => connection.getMeta<UserResponseStructure>("pgg.auth.self").client_id);

    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      playersJson: JSON.stringify(players),
    });
  }

  private handlePlayerJoin(player: PlayerInstance, lobby: LobbyInstance) {
    this.redis.set(
      `loadpolus.userUuid.${player.getSafeConnection().getMeta<UserResponseStructure>("pgg.auth.self").client_id}`,
      lobby.getCode(),
    ).then(() => {
      this.redis.expire(
        `loadpolus.userUuid.${player.getSafeConnection().getMeta<UserResponseStructure>("pgg.auth.self").client_id}`,
        10800,
      );
    });

    this.redis.set(
      `loadpolus.lobbyUuid.${lobby.getMeta<string>("pgg.log.uuid")}`,
      lobby.getCode(),
    );
  }

  private handlePlayerLeave(player: PlayerInstance) {
    this.redis.del(`loadpolus.userUuid.${player.getMeta<UserResponseStructure>("pgg.auth.self").client_id}`);
  }

  private updateHostList(lobby: LobbyInstance): void {
    const hosts = lobby.getActingHosts().map(connection => connection.getMeta<UserResponseStructure>("pgg.auth.self").client_id);

    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      hostsJson: JSON.stringify(hosts),
    });
  }

  private async setNodeName(): Promise<void> {
    this.nodeName = process.env.NP_NODE_HOSTNAME?.trim()
                 ?? this.config?.nodeName
                 ?? (isInDocker() ? await getDropletName() : undefined)
                 ?? this.nodeName;
  }

  private async setNodeAddress(): Promise<void> {
    this.nodeAddress = process.env.NP_DROPLET_ADDRESS?.trim()
                 ?? this.config?.publicIp
                 ?? (isInDocker() ? await getDropletAddress() : undefined)
                 ?? this.nodeAddress;
  }

  // fucking lkgdjskdjgsd;gjsgdgdgg;ajsd;lkj3efasj

  private async fetchNodes(nodesKey: string = "loadpolus.nodes"): Promise<Map<string, Record<string, string>>> {
    let availableNodes: string[];

    try {
      availableNodes = await this.redis.smembers(nodesKey);
    } catch (error) {
      return Promise.reject(error);
    }

    const nodeData = new Map<string, Record<string, string>>();
    const nodePipeline = this.redis.pipeline();

    for (let i = 0; i < availableNodes.length; i++) {
      const node = availableNodes[i];

      nodePipeline.hgetall(`loadpolus.node.${node}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nodeResults: [Error | null, any][];

    try {
      nodeResults = await nodePipeline.exec();
    } catch (error) {
      return Promise.reject(error);
    }

    for (let i = 0; i < nodeResults.length; i++) {
      const result = nodeResults[i];

      if (result[0] !== null) {
        continue;
      }

      result[1].nodeName = availableNodes[i];

      nodeData.set(availableNodes[i], result[1]);
    }

    return nodeData;
  }

  private async selectServer(nodes: string): Promise<Record<string, string> | undefined> {
    const nodeData: Map<string, Record<string, string>> = await this.fetchNodes(nodes);
    let best: string | undefined;

    for (const node of nodeData) {
      if (node[1].maintenance === "true") {
        continue;
      }

      const players = parseInt(node[1].currentConnections, 10);

      if (players >= parseInt(node[1].maxConnections, 10)) {
        continue;
      }

      if (best === undefined) {
        best = node[0];

        continue;
      }

      if (players < parseInt(nodeData.get(best!)!.currentConnections, 10)) {
        best = node[0];
      }
    }

    return best ? nodeData.get(best) : undefined;
  }
}
