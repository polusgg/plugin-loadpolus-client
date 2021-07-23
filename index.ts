import { LobbyCode } from "@nodepolus/framework/src/util/lobbyCode";
import { UserResponseStructure } from "@polusgg/module-polusgg-auth-api/src/types/userResponseStructure";
import { EnumValue } from "@polusgg/plugin-polusgg-api/src/packets/root/setGameOption";
import { GameState, Language, Level, Scene } from "@nodepolus/framework/src/types/enums";
import { ServiceType } from "@polusgg/plugin-polusgg-api/src/types/enums";
import { Services } from "@polusgg/plugin-polusgg-api/src/services";
import { LobbyInstance } from "@nodepolus/framework/src/api/lobby";
import { BasePlugin } from "@nodepolus/framework/src/api/plugin";
import { RedirectPacket } from "@nodepolus/framework/src/protocol/packets/root";
import { readFileSync } from "fs";
import Redis from "ioredis";
import got from "got";
import os from "os";
import { DisconnectReason } from "@nodepolus/framework/src/types";
import { Lobby } from "@nodepolus/framework/src/lobby";

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
          case "loadpolus.lobby.create": {
            const lobbyInfo = JSON.parse(message) as { type: 1; code: string; hostsJson: string } | { type: 2; code: string };

            if (lobbyInfo.type === 1) {
              const code = lobbyInfo.code;
              const newLobby = new Lobby(
                this.server,
                this.server.getDefaultLobbyAddress(),
                this.server.getDefaultLobbyPort(),
                this.server.getDefaultLobbyStartTimerDuration(),
                this.server.getDefaultLobbyTimeToJoinUntilClosed(),
                this.server.getDefaultLobbyTimeToStartUntilClosed(),
                this.server.shouldHideGhostChat(),
                undefined,
                undefined,
                code,
              );

              newLobby.setMeta({
                "loadpolus.hostUuids": JSON.parse(lobbyInfo.hostsJson) as string[],
                loadpolus: true,
              });

              this.redis.publish("loadpolus.lobby.create", JSON.stringify({
                type: 2,
                code: lobbyInfo.code,
              }));
            }
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
                await this.redis.hmset(`loadpolus.node.${this.nodeName}`, {
                  maintenance: "true",
                });

                this.server.on("server.lobby.creating", event => {
                  event.setDisconnectReason(DisconnectReason.custom("This server is shutting down. Please try again."));
                  event.cancel();
                });

                const masterInfo = await this.redis.hgetall("loadpolus.master.info");

                this.server.on("server.lobby.join", async event => {
                  if (event.getConnection().getCurrentScene() == Scene.EndGame) {
                    event.getConnection().sendReliable([new RedirectPacket(masterInfo.host, parseInt(masterInfo.port))]);
                  }
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
                break;
            }
          }
        }
      });

      this.subscriberRedis.subscribe("loadpolus.notifications");
      this.subscriberRedis.subscribe("loadpolus.shutdown");
      this.subscriberRedis.subscribe("loadpolus.lobby.create");
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

      this.redis.del(`loadpolus.lobby.${code}`);
      this.redis.srem(`loadpolus.node.${this.nodeName}.lobbies`, code);
    });

    this.server.on("player.joined", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.left", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.kicked", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("player.banned", event => this.updateCurrentPlayers(event.getLobby()));
    this.server.on("server.lobby.list", event => { event.cancel() });
    this.server.on("game.started", event => this.updateGameState(event.getGame().getLobby()));
    this.server.on("game.ended", event => this.updateGameState(event.getGame().getLobby()));

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

  private updateHostList(lobby: LobbyInstance): void {
    const hosts = lobby.getActingHosts().map(connection => connection.getMeta<UserResponseStructure>("pgg.auth.self").client_id);

    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      hostsJson: JSON.stringify(hosts),
    });
  }

  private updateGameState(lobby: LobbyInstance): void {
    this.redis.hmset(`loadpolus.lobby.${lobby.getCode()}`, {
      gameState: GameState[lobby.getGameState()],
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
}
