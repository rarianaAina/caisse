import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validation des entrées HTTP par les schémas Zod de @caisse/shared.
 *
 * Un seul schéma sert donc à la fois de contrat d'API, de type TypeScript et
 * de garde-fou côté caisse — au lieu de redéclarer chaque forme de données en
 * classes `class-validator`.
 *
 * Usage : `@Body(new ZodValidationPipe(pushRequestSchema)) body: PushRequest`
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        code: 'PAYLOAD_INVALID',
        message: 'Requête invalide',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
