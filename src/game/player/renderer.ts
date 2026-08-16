/**
 * Draws the Optimus rig.
 *
 * Each attachment is a quad positioned in its bone's world frame. Because the
 * batcher carries rotation per vertex and the shader rotates normals to match,
 * a limb's normal-mapped lighting rotates correctly with the limb — without
 * that, the bevels on a swinging arm would stay lit from a fixed direction and
 * the whole rig would read as flat cut-out paper.
 */

import type { SpriteBatch } from '../../gfx/batch.ts';
import { packColor, packMaterial } from '../../gfx/batch.ts';
import { BlendMode } from '../../gfx/device.ts';
import type { Atlas } from '../../art/atlas.ts';
import type { Skeleton } from '../../anim/skeleton.ts';
import { OPTIMUS_ATTACHMENTS, type Attachment } from './rig.ts';
import { Depth } from '../../core/config.ts';

export class OptimusRenderer {
  /** Attachments sorted once, since the order never changes. */
  private readonly ordered: Attachment[];
  private readonly boneIndices: number[];

  constructor(
    private readonly atlas: Atlas,
    skeleton: Skeleton,
  ) {
    this.ordered = [...OPTIMUS_ATTACHMENTS].sort((a, b) => a.order - b.order);
    this.boneIndices = this.ordered.map((attachment) => skeleton.index(attachment.bone));
  }

  /**
   * Draws the character.
   *
   * @param facing +1 or -1; mirrors local offsets so the rig reads correctly
   *   in both directions without needing a second set of art.
   */
  draw(
    batch: SpriteBatch,
    skeleton: Skeleton,
    facing: number,
    options: { tint?: [number, number, number]; emissiveBoost?: number; alpha?: number } = {},
  ): void {
    batch.setTextures(this.atlas.textures);
    batch.setBlend(BlendMode.Premultiplied);

    const world = skeleton.world;
    const tint = options.tint ?? [1, 1, 1];
    const alpha = options.alpha ?? 1;
    const emissiveBoost = options.emissiveBoost ?? 0;

    const color = packColor(tint[0] * alpha, tint[1] * alpha, tint[2] * alpha, alpha);

    for (let i = 0; i < this.ordered.length; i++) {
      const attachment = this.ordered[i]!;
      const bone = this.boneIndices[i]!;
      const entry = this.atlas.get(attachment.sprite);

      const boneX = world.worldX[bone]!;
      const boneY = world.worldY[bone]!;
      const boneRotation = world.worldRotation[bone]!;

      // The attachment offset lives in the bone's local frame, so it has to be
      // rotated by the bone before being added.
      const cos = Math.cos(boneRotation);
      const sin = Math.sin(boneRotation);
      const localX = attachment.x * facing;
      const localY = attachment.y;

      const x = boneX + localX * cos - localY * sin;
      const y = boneY + localX * sin + localY * cos;

      // Mirroring the character mirrors the rotation too, otherwise limbs bend
      // the wrong way when facing left.
      const rotation = boneRotation * facing + attachment.rotation * facing;

      const material = packMaterial(
        (attachment.emissive ?? 0) + emissiveBoost,
        0.5,
        0.5,
        0,
      );

      // Flipping the horizontal UVs is what actually mirrors the artwork.
      const u0 = facing > 0 ? entry.u0 : entry.u1;
      const u1 = facing > 0 ? entry.u1 : entry.u0;

      batch.draw(
        x,
        y,
        attachment.width,
        attachment.height,
        u0,
        entry.v0,
        u1,
        entry.v1,
        Depth.Playfield,
        attachment.tint
          ? packColor(
              attachment.tint[0] * tint[0] * alpha,
              attachment.tint[1] * tint[1] * alpha,
              attachment.tint[2] * tint[2] * alpha,
              alpha,
            )
          : color,
        material,
        rotation,
      );
    }
  }

  /**
   * Draws the character's silhouette into the occluder mask.
   *
   * The player is the most important shadow caster in the game: their own
   * shadow falling across the environment is a large part of what makes them
   * feel physically present in it rather than composited on top.
   */
  drawOccluder(batch: SpriteBatch, skeleton: Skeleton, facing: number): void {
    this.draw(batch, skeleton, facing, { tint: [1, 1, 1] });
  }
}
