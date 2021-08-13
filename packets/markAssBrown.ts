import { MessageReader, MessageWriter } from "@nodepolus/framework/src/util/hazelMessage";
import { RootPacketType } from "@nodepolus/framework/src/types/enums";
import { BaseRootPacket } from "@nodepolus/framework/src/protocol/packets/root";

/**
 * Root Packet ID: `0x9b` (`155`)
 */
export class MarkAssBrownPacket extends BaseRootPacket {
  constructor(
    public ipAddress: string,
    public port: number,
  ) {
    super(RootPacketType.Redirect);
  }

  static deserialize(reader: MessageReader): MarkAssBrownPacket {
    return new MarkAssBrownPacket(
      reader.readBytes(4).getBuffer().join("."),
      reader.readUInt16(),
    );
  }

  clone(): MarkAssBrownPacket {
    return new MarkAssBrownPacket(this.ipAddress, this.port);
  }

  serialize(writer: MessageWriter): void {
    writer.writeBytes(this.ipAddress.split(".").map(octet => parseInt(octet, 10)))
      .writeUInt16(this.port);
  }
}
