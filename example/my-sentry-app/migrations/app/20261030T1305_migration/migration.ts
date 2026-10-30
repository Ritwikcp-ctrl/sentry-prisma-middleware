#!/usr/bin/env -S node
import type { Contract as Start } from '../../snapshots/797cfed44e9c40efbc00a689b87c92c44cd4b60e1ae3d6ffbc0304d8f348aaf5/contract';
import startContract from '../../snapshots/797cfed44e9c40efbc00a689b87c92c44cd4b60e1ae3d6ffbc0304d8f348aaf5/contract.json' with { type: 'json' };
import type { Contract as End } from '../../snapshots/a51b4833fdaffe730572670ccc27dd89af7e0726ab3de7f428d21702d687cc15/contract';
import endContract from '../../snapshots/a51b4833fdaffe730572670ccc27dd89af7e0726ab3de7f428d21702d687cc15/contract.json' with { type: 'json' };
import { Migration, MigrationCLI } from '@prisma/orm-postgres/migration';

export default class M extends Migration<Start, End> {
  override readonly startContractJson = startContract;
  override readonly endContractJson = endContract;

  override get operations() {
    return [];
  }
}

MigrationCLI.run(import.meta.url, M);
