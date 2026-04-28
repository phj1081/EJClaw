import type { RoomThreadEntry } from './roomThread';

type RoomAttachment = NonNullable<RoomThreadEntry['attachments']>[number];

function attachmentDisplayName(attachment: RoomAttachment): string {
  if (attachment.name) return attachment.name;
  const segments = attachment.path.split(/[\\/]/);
  return segments.at(-1) || 'attachment';
}

function attachmentUrl(attachment: RoomAttachment): string {
  return `/api/attachments?path=${encodeURIComponent(attachment.path)}`;
}

export function RoomAttachmentGallery({
  attachments,
}: {
  attachments?: RoomThreadEntry['attachments'];
}) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <ul className="room-attachments">
      {attachments.map((attachment) => {
        const name = attachmentDisplayName(attachment);
        const url = attachmentUrl(attachment);
        return (
          <li className="room-attachment" key={`${attachment.path}:${name}`}>
            <a href={url} rel="noreferrer" target="_blank">
              <img alt={name} loading="lazy" src={url} />
              <span>{name}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
